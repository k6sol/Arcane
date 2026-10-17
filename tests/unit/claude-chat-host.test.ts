import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The ACTUAL desktop claude-chat.cjs host with a FAKE spawn that replays recorded Claude Code 2.1.301 stream-json lines.
// No native CLI, daemon, provider, network, dialog or renderer runs; the handoff broker and window are scripted.
const require = createRequire(join(process.cwd(), 'package.json'));
const chat = require(join(process.cwd(), 'apps/desktop/electron/claude-chat.cjs')) as any;
const SESSION = '18242a29-6d33-4477-8247-a08f685e2c29';
const CREDENTIAL = 'C'.repeat(43);
const ORIGIN = 'http://127.0.0.1:45871';
const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -p, --print                           Print response and exit
`;
const line = (value: unknown) => JSON.stringify(value) + '\n';
// Recorded shapes (trimmed) from `claude -p --output-format stream-json --verbose --include-partial-messages`.
const init = (session = SESSION) => line({ type: 'system', subtype: 'init', cwd: 'C:\\x', session_id: session, tools: [], mcp_servers: [], model: 'claude-sonnet-5-5', permissionMode: 'default', apiKeySource: 'none', claude_code_version: '2.1.301' });
const delta = (text: string) => line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: SESSION, parent_tool_use_id: null, uuid: randomUUID() });
const assistant = (content: unknown[], parent: string | null = null) => line({ type: 'assistant', message: { model: 'claude-sonnet-5-5', id: 'msg_1', type: 'message', role: 'assistant', content }, parent_tool_use_id: parent, session_id: SESSION, uuid: randomUUID() });
const toolResult = (id: string, isError = false) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] }, parent_tool_use_id: null, session_id: SESSION });
const rateLimit = line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, session_id: SESSION });
const result = (extra: Record<string, unknown> = {}) => line({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: SESSION, total_cost_usd: 0.0119654, num_turns: 1,
  usage: { input_tokens: 2, cache_creation_input_tokens: 2933, cache_read_input_tokens: 649, output_tokens: 4 }, ...extra });

class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); pid = 4242; exitCode: number | null = null; signalCode: string | null = null; killed = 0; input = '';
  stdin: any;
  readonly onInput: (child: FakeChild) => void;
  constructor(onInput: (child: FakeChild) => void) {
    super(); this.onInput = onInput;
    this.stdin = { on() {}, end: (text: string) => { this.input = text; setImmediate(() => this.onInput(this)); } };
  }
  write(text: string | Buffer) { this.stdout.emit('data', Buffer.isBuffer(text) ? text : Buffer.from(text)); }
  close(code: number | null = 0) { if (this.exitCode !== null || this.signalCode) return; this.exitCode = code; this.emit('close', code, null); }
  kill() { this.killed++; setImmediate(() => { if (this.exitCode === null) { this.signalCode = 'SIGTERM'; this.emit('close', null, 'SIGTERM'); } }); return true; }
}
type Script = (child: FakeChild, args: string[]) => void;
const replay = (...lines: string[]): Script => child => { for (const l of lines) child.write(l); child.close(0); };

async function fixture(t: TestContext, options: { auth?: unknown; locate?: string | null; response?: number; limits?: Record<string, number>; directory?: string } = {}) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'arcane-claude-chat-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), state = options.directory ?? join(root, 'state');
  await mkdir(project); await mkdir(state, { recursive: true });
  const events: any[] = [], spawns: { command: string; args: string[]; options: any; child: FakeChild }[] = [], dialogs: any[] = [], prepared: any[] = [], released: string[] = [];
  const scripts: Script[] = [];
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send(channel: string, event: unknown) { assert.equal(channel, 'arcane:claude-chat-event'); events.push(JSON.parse(JSON.stringify(event))); } } };
  const spawn = (command: string, args: string[], spawnOptions: any) => {
    const child = new FakeChild(c => {
      if (args[0] === '-p') { const script = scripts.shift(); if (script) script(c, args); }
    });
    spawns.push({ command, args: [...args], options: spawnOptions, child });
    if (args[0] !== '-p') setImmediate(() => {
      if (args[0] === '--version') child.write('2.1.301 (Claude Code)\n');
      else if (args[0] === 'auth') child.write(JSON.stringify(options.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'private@example.invalid' }));
      else if (args[0] === '--help') child.write(HELP);
      child.stderr.emit('data', Buffer.from('helper stderr private@example.invalid'));
      child.close(0);
    });
    return child;
  };
  const host = chat.createClaudeChat({
    projectPath: project, stateDirectory: state, getWindow: () => window, spawn, platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\u', ANTHROPIC_API_KEY: 'sk-ant-never-forward', ARCANE_LOCAL_TOKEN: 'inherited-never' },
    homedir: () => 'C:\\Users\\u', locate: async () => options.locate === undefined ? 'C:\\Users\\u\\.local\\bin\\claude.exe' : options.locate,
    dialog: { showMessageBox: async (w: unknown, value: any) => { dialogs.push(value); assert.equal(w, window); return { response: options.response ?? 1 }; } },
    handoff: {
      prepare: async (selection: unknown) => {
        const receipt: any = { handoffId: randomUUID(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), configPath: join(root, 'arcane.mcp.json') };
        Object.defineProperty(receipt, 'env', { value: Object.freeze({ ARCANE_DAEMON_URL: ORIGIN, ARCANE_LOCAL_TOKEN: CREDENTIAL }), enumerable: false });
        prepared.push({ selection, receipt }); return Object.freeze(receipt);
      },
      release: async (id: string) => { released.push(id); return true; },
    },
    instructions: async () => 'ARCANE TASK INSTRUCTIONS FIXTURE',
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const turns = () => spawns.filter(s => s.args[0] === '-p');
  const done = (turnId: string) => waitFor(() => events.find(e => e.turnId === turnId && e.type === 'done'));
  return { root, project, state, host, events, spawns, turns, scripts, dialogs, prepared, released, done, window };
}
async function waitFor<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = read(); if (value) return value; if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const turnInput = (text: string, conversationId: string | null = null) => ({ conversationId, text, model: 'sonnet', effort: 'high' });

test('status reads version, subscription sign-in and help choices without leaking helper output', async t => {
  const f = await fixture(t);
  const s = await f.host.status();
  assert.deepEqual({ ...s, models: [...s.models], efforts: [...s.efforts] }, { installed: true, signedIn: true, cliVersion: '2.1.301', models: ['fable', 'opus', 'sonnet'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', message: null });
  assert.ok(Object.isFrozen(s)); assert.ok(!JSON.stringify(s).includes('private@'));
  assert.deepEqual(f.spawns.map(x => x.args), [['--version'], ['auth', 'status', '--json'], ['--help']]);
  assert.ok(f.spawns.every(x => x.options.shell === false && x.options.windowsHide === true && !('ANTHROPIC_API_KEY' in x.options.env) && !('ARCANE_LOCAL_TOKEN' in x.options.env)));
  const missing = await fixture(t, { locate: null });
  assert.equal((await missing.host.status()).installed, false);
  assert.match((await missing.host.status()).message, /not found/);
  const out = await fixture(t, { auth: { loggedIn: false } });
  assert.deepEqual([(await out.host.status()).signedIn, (await out.host.status()).message], [false, chat.CLAUDE_CHAT_MESSAGES.signedOut]);
  const api = await fixture(t, { auth: { loggedIn: true, authMethod: 'api_key' } });
  assert.deepEqual([(await api.host.status()).signedIn, (await api.host.status()).message], [false, chat.CLAUDE_CHAT_MESSAGES.notSubscription]);
});

test('turn lifecycle: exact argv, stdin prompt, scoped env, streamed events, tool chips, usage and persisted transcript', async t => {
  const f = await fixture(t);
  f.scripts.push(replay(init(), rateLimit, delta('Hel'), delta('lo'), assistant([{ type: 'text', text: 'Hello' }]),
    assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__arcane__scene_create', input: {} }]), toolResult('toolu_1'),
    assistant([{ type: 'tool_use', id: 'toolu_2', name: 'mcp__arcane__script_update', input: {} }]), toolResult('toolu_2', true),
    assistant([{ type: 'text', text: 'sub' }], 'toolu_9'), assistant([{ type: 'thinking', thinking: 'private' }]), result()));
  const reply = await f.host.send(turnInput('Build a red door in the lobby please'));
  assert.ok(Object.isFrozen(reply)); assert.match(reply.turnId, /^[0-9a-f-]{36}$/); assert.match(reply.conversationId, /^[0-9a-f-]{36}$/);
  const done = await f.done(reply.turnId);
  assert.deepEqual(done, { turnId: reply.turnId, conversationId: reply.conversationId, type: 'done', ok: true, error: null, usage: { inputTokens: 3584, outputTokens: 4, costUsd: 0.0119654 }, usageLimit: null });
  const [run] = f.turns();
  assert.equal(run!.command, 'C:\\Users\\u\\.local\\bin\\claude.exe'); assert.equal(run!.options.cwd, f.project);
  assert.deepEqual(run!.args.slice(0, -2), ['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', join(f.root, 'arcane.mcp.json'), '--strict-mcp-config', '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'default',
    '--tools', '', '--allowedTools', 'mcp__arcane']);
  assert.equal(run!.args.at(-2), '--append-system-prompt'); assert.match(run!.args.at(-1)!, /Arcane desktop chat[\s\S]*ARCANE TASK INSTRUCTIONS FIXTURE/);
  assert.ok(!run!.args.includes('--resume')); assert.ok(!run!.args.some(a => a.includes(CREDENTIAL)));
  assert.equal(run!.child.input, 'Build a red door in the lobby please');
  assert.equal(run!.options.env.ARCANE_LOCAL_TOKEN, CREDENTIAL); assert.equal(run!.options.env.ARCANE_DAEMON_URL, ORIGIN);
  assert.ok(!('ANTHROPIC_API_KEY' in run!.options.env)); assert.equal(run!.options.shell, false); assert.equal(run!.options.windowsHide, true);
  assert.equal(f.dialogs.length, 1); assert.match(f.dialogs[0].message, /Arcane project tools/); assert.ok(f.dialogs[0].detail.includes(f.project));
  const mine = f.events.filter(e => e.turnId === reply.turnId).map(e => e.type + ':' + (e.text ?? e.message?.text ?? '') + (e.message?.tool ? ':' + e.message.tool.status : ''));
  assert.deepEqual(mine, ['delta:Hel', 'delta:lo', 'message:Hello', 'tool:scene_create:started', 'tool:scene_create:finished', 'tool:script_update:started', 'tool:script_update:failed', 'done:']);
  const history = await f.host.history(reply.conversationId);
  assert.deepEqual(history.messages.map((m: any) => [m.role, m.text, m.tool?.status ?? null]),
    [['user', 'Build a red door in the lobby please', null], ['assistant', 'Hello', null], ['tool', 'scene_create', 'finished'], ['tool', 'script_update', 'failed']]);
  assert.ok(history.messages.every((m: any) => /^\d{4}-\d{2}-\d{2}T/.test(m.at)));
  const list = await f.host.list();
  assert.deepEqual(list.conversations.map((c: any) => [c.conversationId, c.title, c.model, c.effort]), [[reply.conversationId, 'Build a red door in the lobby please', 'sonnet', 'high']]);
});

test('second turn resumes the recorded session, reuses the approval and credential, and the title is the first 60 chars', async t => {
  const f = await fixture(t);
  f.scripts.push(replay(init(), assistant([{ type: 'text', text: 'one' }]), result()), replay(init(), assistant([{ type: 'text', text: 'two' }]), result()));
  const long = 'x'.repeat(80);
  const first = await f.host.send(turnInput(long)); await f.done(first.turnId);
  const second = await f.host.send(turnInput('again', first.conversationId)); await f.done(second.turnId);
  assert.equal(second.conversationId, first.conversationId);
  const [a, b] = f.turns();
  assert.ok(!a!.args.includes('--resume'));
  assert.deepEqual(b!.args.slice(-2), ['--resume', SESSION]);
  assert.equal(f.dialogs.length, 1, 'asked once per project session'); assert.equal(f.prepared.length, 1, 'credential reused while unexpired');
  assert.equal((await f.host.list()).conversations[0].title, 'x'.repeat(60));
  assert.deepEqual((await f.host.history(first.conversationId)).messages.map((m: any) => m.text), [long, 'one', 'again', 'two']);
  await assert.rejects(f.host.send(turnInput('x', randomUUID())), /no longer exists/);
});

test('persistence is atomic, survives a new host, honours bounds, and removes conversations', async t => {
  const f = await fixture(t, { limits: { messages: 3, conversations: 2 } });
  for (let i = 0; i < 3; i++) f.scripts.push(replay(init(), assistant([{ type: 'text', text: 'reply ' + i }]), result()));
  const a = await f.host.send(turnInput('first')); await f.done(a.turnId);
  const b = await f.host.send(turnInput('more', a.conversationId)); await f.done(b.turnId);
  assert.deepEqual((await f.host.history(a.conversationId)).messages.map((m: any) => m.text), ['reply 0', 'more', 'reply 1'], 'oldest messages dropped at the bound');
  const files = await readdir(f.state, { recursive: true });
  assert.ok(!files.some(name => String(name).endsWith('.tmp')), 'no temporary files remain');
  const index = JSON.parse(await readFile(join(f.state, 'index.json'), 'utf8'));
  assert.equal(index.version, 1); assert.equal(index.conversations[0].sessionId, SESSION);
  const transcript = JSON.parse(await readFile(join(f.state, 'conversations', a.conversationId + '.json'), 'utf8'));
  assert.equal(transcript.conversationId, a.conversationId); assert.equal(transcript.messages.length, 3);
  // A fresh host on the same directory reads the same state.
  const g = await fixture(t, { directory: f.state });
  assert.deepEqual((await g.host.list()).conversations.map((c: any) => c.conversationId), [a.conversationId]);
  assert.equal((await g.host.history(a.conversationId)).messages.length, 3);
  // Conversation bound: the oldest idle conversation is evicted.
  const c = await f.host.send(turnInput('second conversation')); await f.done(c.turnId);
  assert.equal((await f.host.list()).conversations.length, 2);
  f.scripts.push(replay(init(), result()));
  const d = await f.host.send(turnInput('third conversation')); await f.done(d.turnId);
  const ids = (await f.host.list()).conversations.map((x: any) => x.conversationId);
  assert.equal(ids.length, 2); assert.ok(!ids.includes(a.conversationId));
  assert.equal(await f.host.remove(c.conversationId), true); assert.equal(await f.host.remove(c.conversationId), false);
  await assert.rejects(f.host.history(c.conversationId), /no longer exists/);
  // An unreadable index is set aside, never parsed into state.
  await writeFile(join(f.state, 'index.json'), '{not json');
  const h = await fixture(t, { directory: f.state });
  assert.deepEqual((await h.host.list()).conversations, []);
  assert.ok((await readdir(f.state)).some(name => name.startsWith('index.json.unreadable-')));
});

test('stop kills only the spawned child tree and reports a stopped turn; one active turn per conversation', async t => {
  const f = await fixture(t);
  f.scripts.push((child: FakeChild) => { child.write(init()); child.write(delta('partial')); });
  const reply = await f.host.send(turnInput('long task'));
  await waitFor(() => f.events.find(e => e.type === 'delta'));
  await assert.rejects(f.host.send(turnInput('meanwhile', reply.conversationId)), /still running/);
  assert.equal(await f.host.stop(reply.turnId), true);
  const done = await f.done(reply.turnId);
  assert.deepEqual([done.ok, done.error], [false, 'Stopped.']);
  const [run] = f.turns(); assert.equal(run!.child.killed, 1);
  const killer = f.spawns.find(s => s.command.toLowerCase().endsWith('taskkill.exe'));
  assert.deepEqual(killer?.args, ['/T', '/F', '/PID', '4242']); assert.equal(killer?.command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.equal(await f.host.stop(reply.turnId), false); assert.equal(await f.host.stop(randomUUID()), false);
  assert.deepEqual((await f.host.history(reply.conversationId)).messages.map((m: any) => m.role), ['user', 'error']);
});

test('malformed, oversized and unknown output is ignored; missing results become fixed messages', async t => {
  const f = await fixture(t, { limits: { lineBytes: 1024 } });
  f.scripts.push(child => {
    child.write('not json\n'); child.write('[1,2]\n'); child.write('"text"\n'); child.write(line({ type: 'mystery', payload: 1 })); child.write('{"type":5}\n');
    child.write('{"type":"assistant","message":{"content":"x"}}\n'); child.write(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(4000) }] } }));
    child.write(Buffer.from([0xff, 0xfe, 0x0a])); child.write(init()); const r = result(); child.write(r.slice(0, 20)); child.write(r.slice(20)); child.close(0);
  });
  const a = await f.host.send(turnInput('go')); const done = await f.done(a.turnId);
  assert.equal(done.ok, true);
  assert.ok(!f.events.some(e => e.type === 'message' && e.message.text.startsWith('yyy')), 'the oversized line was skipped');
  f.scripts.push(replay(init(), delta('half')));
  const b = await f.host.send(turnInput('go', a.conversationId));
  assert.deepEqual([(await f.done(b.turnId)).ok, (await f.done(b.turnId)).error], [false, 'Claude Code ended without a reply.']);
  f.scripts.push(child => { child.write(init()); child.close(1); });
  const c = await f.host.send(turnInput('go', a.conversationId));
  assert.equal((await f.done(c.turnId)).error, 'Claude Code stopped before finishing the reply.');
});

test('stderr and unsafe result text never reach events or transcripts; short plain CLI errors do', async t => {
  const f = await fixture(t);
  const secret = 'sk-ant-oat01-' + 'Z'.repeat(40), email = 'private@example.invalid';
  f.scripts.push(child => { child.stderr.emit('data', Buffer.from('Error: ' + secret + ' ' + email + '\n')); child.write(init());
    child.write(result({ subtype: 'error_during_execution', is_error: true, result: 'Failed for ' + email + ' see https://example.invalid/' + secret })); child.close(1); });
  const a = await f.host.send(turnInput('go'));
  const done = await f.done(a.turnId);
  assert.deepEqual([done.ok, done.error], [false, 'Claude Code could not finish this reply.']);
  f.scripts.push(replay(init(), result({ subtype: 'success', is_error: true, result: 'Claude usage limit reached · resets 3pm' })));
  const b = await f.host.send(turnInput('go', a.conversationId));
  assert.deepEqual([(await f.done(b.turnId)).error, (await f.done(b.turnId)).usageLimit], [chat.CLAUDE_CHAT_MESSAGES.usageLimit, { resetsAt: null }], 'a usage-limit sentence maps to the fixed message');
  f.scripts.push(replay(init(), result({ subtype: 'success', is_error: true, result: 'Credit balance is too low' })));
  const c = await f.host.send(turnInput('go', a.conversationId));
  assert.equal((await f.done(c.turnId)).error, 'Credit balance is too low', 'other short plain CLI errors still pass through');
  const files = await readdir(f.state, { recursive: true });
  const stored = (await Promise.all(files.filter(n => String(n).endsWith('.json')).map(n => readFile(join(f.state, String(n)), 'utf8')))).join('\n');
  for (const haystack of [JSON.stringify(f.events), stored]) { assert.ok(!haystack.includes(secret)); assert.ok(!haystack.includes(email)); assert.ok(!haystack.includes(CREDENTIAL)); }
  assert.equal(chat.safeResultText('Not logged in · Please run /login'), 'Not logged in · Please run /login');
  assert.equal(chat.safeResultText('see C:\\Users\\u\\.claude'), null);
});

test('declined approval starts nothing and asks again; unavailable credential and unknown model fail closed', async t => {
  const f = await fixture(t, { response: 0 });
  const a = await f.host.send(turnInput('go'));
  assert.equal((await f.done(a.turnId)).error, chat.CLAUDE_CHAT_MESSAGES.declined);
  assert.equal(f.turns().length, 0); assert.equal(f.prepared.length, 0);
  const b = await f.host.send(turnInput('go', a.conversationId)); await f.done(b.turnId);
  assert.equal(f.dialogs.length, 2);
  const g = await fixture(t);
  const c = await g.host.send({ conversationId: null, text: 'go', model: 'gpt', effort: 'high' });
  assert.equal((await g.done(c.turnId)).error, chat.CLAUDE_CHAT_MESSAGES.selection);
  assert.equal(g.turns().length, 0);
  const signedOut = await fixture(t, { auth: { loggedIn: false } });
  const d = await signedOut.host.send(turnInput('go'));
  assert.equal((await signedOut.done(d.turnId)).error, chat.CLAUDE_CHAT_MESSAGES.signedOut);
});

test('dispose stops running turns and revokes the credentials this host minted', async t => {
  const f = await fixture(t);
  f.scripts.push(child => { child.write(init()); });
  const a = await f.host.send(turnInput('go'));
  await waitFor(() => f.turns()[0]?.child.input);
  await f.host.dispose();
  const done = await f.done(a.turnId);
  assert.deepEqual([done.ok, done.error], [false, 'The workspace closed, so the reply was stopped.']);
  assert.equal(f.turns()[0]!.child.killed, 1);
  assert.deepEqual(f.released, [f.prepared[0].receipt.handoffId]);
  await assert.rejects(f.host.send(turnInput('later')), /unavailable/);
});

test('IPC accepts only the trusted main frame and exact argument shapes', async t => {
  const f = await fixture(t);
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<any>>();
  const frame = { url: ORIGIN + '/studio' }, contents = { isDestroyed: () => false, mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  const session = { current: { window, origin: ORIGIN, epoch: {} } as any };
  const calls: string[] = [];
  const host = Object.freeze({ status: async () => { calls.push('status'); return { ok: 1 }; }, list: async () => { calls.push('list'); return {}; },
    history: async (id: string) => { calls.push('history:' + id); return {}; }, send: async (input: any) => { calls.push('send'); assert.ok(Object.isFrozen(input)); return f.host.send(input); },
    stop: async () => { calls.push('stop'); return false; }, remove: async () => { calls.push('remove'); return false; } });
  chat.installClaudeChatIpc({ handle: (channel: string, handler: any) => handlers.set(channel, handler) }, { getSession: () => session.current, getHost: () => host });
  assert.deepEqual([...handlers.keys()].sort(), ['history', 'list', 'remove', 'send', 'status', 'stop'].map(a => 'arcane:claude-chat-' + a));
  const event = { sender: contents, senderFrame: frame };
  const invoke = (action: string, ...args: any[]) => handlers.get('arcane:claude-chat-' + action)!(event, ...args);
  assert.deepEqual(await invoke('status'), { ok: 1 });
  const id = randomUUID(); await invoke('history', id); await invoke('stop', id); await invoke('remove', id);
  const before = calls.length;
  for (const [action, args] of [['status', [1]], ['list', [{}]], ['history', []], ['history', ['../x']], ['stop', [id, id]], ['remove', [id.toUpperCase()]],
    ['send', []], ['send', [{ conversationId: null, text: 'x', model: 'sonnet' }]], ['send', [{ conversationId: null, text: 'x', model: 'sonnet', effort: 'high', extra: 1 }]],
    ['send', [{ conversationId: 'nope', text: 'x', model: 'sonnet', effort: 'high' }]], ['send', [{ conversationId: null, text: 'x', model: 'son net', effort: 'high' }]],
    ['send', [Object.create({ conversationId: null, text: 'x', model: 'sonnet', effort: 'high' })]]] as [string, unknown[]][])
    await assert.rejects(invoke(action, ...args), (error: Error) => error.message === 'Claude chat is unavailable.', action + ' ' + JSON.stringify(args));
  await assert.rejects(invoke('send', { conversationId: null, text: 'x'.repeat(100001), model: 'sonnet', effort: 'high' }), { message: 'Message is empty or too long.' });
  await assert.rejects(invoke('send', { conversationId: null, text: '   ', model: 'sonnet', effort: 'high' }), { message: 'Message is empty or too long.' });
  assert.equal(calls.length, before, 'malformed envelopes never reach the host');
  for (const bad of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: ORIGIN + '/studio' } }]) await assert.rejects(handlers.get('arcane:claude-chat-status')!(bad), /unavailable/);
  frame.url = 'https://evil.example/'; await assert.rejects(invoke('status'), /unavailable/); frame.url = ORIGIN + '/studio';
  session.current = null; await assert.rejects(invoke('status'), /unavailable/); session.current = { window, origin: ORIGIN, epoch: {} };
  f.scripts.push(child => { child.write(init()); });
  const reply = await invoke('send', turnInput('hello'));
  await assert.rejects(invoke('send', turnInput('again', reply.conversationId)), { message: 'Another Claude chat reply is still running in this conversation.' });
  // A project epoch change across the await withholds the reply.
  const swap = { ...host, list: async () => { session.current = { window, origin: ORIGIN, epoch: {} }; return {}; } };
  const swapped = new Map<string, any>();
  chat.installClaudeChatIpc({ handle: (channel: string, handler: any) => swapped.set(channel, handler) }, { getSession: () => session.current, getHost: () => swap });
  await assert.rejects(swapped.get('arcane:claude-chat-list')(event), /unavailable/);
  await f.host.dispose(); await f.done(reply.turnId);
});

test('broker prepareChat mints, seals and returns a non-enumerable credential over the ACTUAL daemon routes; releaseChat revokes and cleans', async t => {
  const { createNativeHandoffRoutes } = await import('../../apps/daemon/src/native-handoff-routes.js');
  const { createServer } = await import('node:http');
  const { createNativeHandoffHost } = require(join(process.cwd(), 'apps/desktop/electron/native-handoff-host.cjs')) as any;
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'arcane-claude-chat-broker-')));
  const project = join(root, 'project'), runtimeDirectory = join(root, 'runtime'), bin = join(root, 'bin');
  for (const dir of [project, runtimeDirectory, bin]) await mkdir(dir);
  const nodePath = join(bin, 'node.exe'), mcpEntry = join(bin, 'main.js'); await writeFile(nodePath, 'not executed'); await writeFile(mcpEntry, 'not executed');
  const human = 'd'.repeat(64), routes = createNativeHandoffRoutes({ projectPath: project });
  let origin = '';
  const server = createServer((request, response) => { void (async () => {
    if (await routes.handle(request, response, new URL(request.url ?? '/', origin), human, origin)) return;
    response.writeHead(404); response.end('{}');
  })(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const session = { projectPath: project, runtimeDirectory, nodePath, mcpEntry, origin, controlToken: human, epoch: {} };
  const broker = createNativeHandoffHost({ getSession: () => session, getChoices: () => null, confirm: async () => false, launchTerminal: async () => 'failed' });
  t.after(async () => { await broker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); routes.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(Object.keys(broker).sort(), ['cancelPending', 'dispose', 'launch', 'list', 'revoke'], 'chat ports stay outside the enumerable human API');
  for (const bad of [null, { model: 'sonnet' }, { model: 'son net', effort: 'high' }, { model: 'sonnet', effort: 'high', extra: 1 }]) assert.equal(await broker.prepareChat(bad), null);
  const receipt = await broker.prepareChat({ model: 'sonnet', effort: 'high' });
  assert.ok(receipt && Object.isFrozen(receipt));
  assert.deepEqual(Object.keys(receipt).sort(), ['configPath', 'expiresAt', 'handoffId']);
  assert.match(receipt.env.ARCANE_LOCAL_TOKEN, /^[A-Za-z0-9_-]{43}$/); assert.equal(receipt.env.ARCANE_DAEMON_URL, origin);
  assert.ok(!JSON.stringify(receipt).includes(receipt.env.ARCANE_LOCAL_TOKEN));
  const config = await readFile(receipt.configPath, 'utf8');
  assert.ok(config.includes('"arcane"') && config.includes('${ARCANE_LOCAL_TOKEN}') && !config.includes(receipt.env.ARCANE_LOCAL_TOKEN), 'token-free owned config for the arcane server');
  const listed = await broker.list();
  assert.deepEqual(listed.handoffs.map((h: any) => [h.handoffId, h.state, h.owned]), [[receipt.handoffId, 'sealed', true]]);
  assert.ok(Date.parse(receipt.expiresAt) - Date.now() > 25 * 60000, 'about 30 minutes of authority');
  assert.equal(await broker.releaseChat(receipt.handoffId), true);
  assert.deepEqual((await broker.list()).handoffs.map((h: any) => h.state), ['revoked']);
  assert.deepEqual(await readdir(runtimeDirectory), [], 'owned config removed');
  assert.equal(await broker.releaseChat(randomUUID()), false);
});

test('usage and rate limits map to one fixed message with a bounded reset time; the raw text never crosses IPC', async t => {
  const f = await fixture(t);
  const raw = 'You have hit your limit · resets 3pm (America/New_York) https://claude.ai/upgrade ' + 'Q'.repeat(40);
  const rejected = (resetsAt: unknown) => line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }, session_id: SESSION });
  f.scripts.push(replay(init(), rejected(1792104000), result({ subtype: 'success', is_error: true, result: raw })));
  const a = await f.host.send(turnInput('go'));
  const done = await f.done(a.turnId);
  assert.deepEqual([done.ok, done.error, done.usageLimit], [false, chat.CLAUDE_CHAT_MESSAGES.usageLimit, { resetsAt: 1792104000 }]);
  // A rejected rate_limit_event alone (the CLI exits without a result) is still the usage limit; unsafe reset values are dropped.
  f.scripts.push(child => { child.write(init()); child.write(rejected('soon; see https://example.invalid')); child.close(1); });
  const b = await f.host.send(turnInput('go', a.conversationId));
  assert.deepEqual([(await f.done(b.turnId)).error, (await f.done(b.turnId)).usageLimit], [chat.CLAUDE_CHAT_MESSAGES.usageLimit, { resetsAt: null }]);
  // Legacy result sentence with an embedded epoch, and an HTTP 429 result.
  f.scripts.push(replay(init(), result({ subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1792107600' })));
  const c = await f.host.send(turnInput('go', a.conversationId));
  assert.deepEqual((await f.done(c.turnId)).usageLimit, { resetsAt: 1792107600 });
  f.scripts.push(replay(init(), result({ subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'API Error' })));
  const d = await f.host.send(turnInput('go', a.conversationId));
  assert.equal((await f.done(d.turnId)).error, chat.CLAUDE_CHAT_MESSAGES.usageLimit);
  // A warning-level event followed by a completed reply is not a limit.
  f.scripts.push(replay(init(), line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1792104000 }, session_id: SESSION }), result()));
  const e = await f.host.send(turnInput('go', a.conversationId));
  assert.deepEqual([(await f.done(e.turnId)).ok, (await f.done(e.turnId)).usageLimit], [true, null]);
  assert.equal(f.turns().length, 5, 'one spawn per explicit send: nothing is retried');
  const files = await readdir(f.state, { recursive: true });
  const stored = (await Promise.all(files.filter(n => String(n).endsWith('.json')).map(n => readFile(join(f.state, String(n)), 'utf8')))).join('\n');
  for (const haystack of [JSON.stringify(f.events), stored]) { assert.ok(!haystack.includes('claude.ai/upgrade')); assert.ok(!haystack.includes('America/New_York')); }
  assert.equal(chat.usageLimitResult({ type: 'result', subtype: 'success', is_error: false, result: 'usage limit reached' }), null);
});

test('preload forwards a usage limit only as the fixed engine message with a bounded reset time', async () => {
  const vm = await import('node:vm');
  const source = await readFile(join(process.cwd(), 'apps/desktop/electron/preload.cjs'), 'utf8');
  let exposed: any; const listeners: ((event: unknown, payload: unknown) => void)[] = [];
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
    ipcRenderer: { on: (_channel: string, fn: any) => listeners.push(fn), removeListener() {}, invoke: async () => null } }) });
  const seen: any[] = []; exposed.claudeChat.onEvent((event: unknown) => seen.push(event));
  const base = { turnId: randomUUID(), conversationId: randomUUID(), type: 'done', ok: false, usage: null };
  const send = (value: unknown) => { seen.length = 0; listeners[0]!({}, value); return seen[0] ? JSON.parse(JSON.stringify(seen[0])) : null; };
  const message = chat.CLAUDE_CHAT_MESSAGES.usageLimit;
  assert.deepEqual(send({ ...base, error: message, usageLimit: { resetsAt: 1792104000, extra: 'x' } }).usageLimit, { resetsAt: 1792104000 });
  assert.deepEqual(send({ ...base, error: message, usageLimit: null }).usageLimit, null);
  assert.equal(send({ ...base, error: 'Failed', usageLimit: undefined }).usageLimit, null, 'older events without the field still pass');
  assert.equal(send({ ...base, error: 'see https://example.invalid', usageLimit: { resetsAt: null } }), null, 'a limit never carries another text');
  assert.equal(send({ ...base, error: message, usageLimit: { resetsAt: 'soon' } }), null);
  assert.equal(send({ ...base, ok: true, error: null, usageLimit: { resetsAt: null } }), null);
  const renderer = await readFile(join(process.cwd(), 'apps/desktop/src/claude-chat.ts'), 'utf8');
  assert.ok(source.includes(JSON.stringify(message).slice(1, -1)) && renderer.includes(message), 'engine, preload and renderer share one fixed message');
});
