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

async function fixture(t: TestContext, options: { auth?: unknown; help?: string; locate?: string | null; response?: number; limits?: Record<string, number>; directory?: string; permissions?: unknown; expiresInMs?: number } = {}) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'arcane-claude-chat-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), state = options.directory ?? join(root, 'state');
  const command = join(root, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
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
      else if (args[0] === '--help') child.write(options.help ?? HELP);
      child.stderr.emit('data', Buffer.from('helper stderr private@example.invalid'));
      child.close(0);
    });
    return child;
  };
  const host = chat.createClaudeChat({
    projectPath: project, stateDirectory: state, getWindow: () => window, spawn, platform: process.platform,
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\u', ANTHROPIC_API_KEY: 'sk-ant-never-forward', ARCANE_LOCAL_TOKEN: 'inherited-never' },
    homedir: () => join(root, 'home'), locate: async () => options.locate === undefined ? command : options.locate,
    dialog: { showMessageBox: async (w: unknown, value: any) => { dialogs.push(value); assert.equal(w, window); return { response: options.response ?? 1 }; } },
    handoff: {
      prepare: async (selection: unknown) => {
        const receipt: any = { handoffId: randomUUID(), expiresAt: new Date(Date.now() + (options.expiresInMs ?? 30 * 60000)).toISOString(), configPath: join(root, 'arcane.mcp.json') };
        Object.defineProperty(receipt, 'env', { value: Object.freeze({ ARCANE_DAEMON_URL: ORIGIN, ARCANE_LOCAL_TOKEN: CREDENTIAL }), enumerable: false });
        prepared.push({ selection, receipt }); return Object.freeze(receipt);
      },
      release: async (id: string) => { released.push(id); return true; },
    },
    instructions: async () => 'ARCANE TASK INSTRUCTIONS FIXTURE',
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
  const turns = () => spawns.filter(s => s.args[0] === '-p');
  const done = (turnId: string) => waitFor(() => events.find(e => e.turnId === turnId && e.type === 'done'));
  return { root, project, state, command, host, events, spawns, turns, scripts, dialogs, prepared, released, done, window };
}
async function waitFor<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = read(); if (value) return value; if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const turnInput = (text: string, conversationId: string | null = null) => ({ conversationId, text, model: 'sonnet', effort: 'high' });

test('status reads version, subscription sign-in and help choices without leaking helper output', async t => {
  const f = await fixture(t);
  const s = await f.host.status();
  assert.deepEqual({ ...s, models: [...s.models], efforts: [...s.efforts], resolved: { ...s.resolved } }, { installed: true, signedIn: true, cliVersion: '2.1.301', models: ['fable', 'opus', 'sonnet'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', resolved: { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, message: null });
  assert.ok(Object.isFrozen(s.resolved));
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

test('aliases resolve to concrete models: listed help ids, then the init model a turn reported, then the maintained table', async t => {
  assert.deepEqual({ ...chat.CLAUDE_ALIAS_MODELS }, { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });
  // (a) A versioned id listed in --help wins for its family; it is not offered as a separate alias.
  const listed = HELP.replace("'fable', 'opus', or 'sonnet') or a", "'fable', 'opus', or 'sonnet') or a full name such as 'claude-opus-5-6' or a");
  const parsed = chat.parseChoices(listed);
  assert.deepEqual([parsed.aliases, parsed.ids], [['fable', 'opus', 'sonnet'], ['claude-opus-5-6']]);
  const a = await fixture(t, { help: listed });
  assert.deepEqual({ ...(await a.host.status()).resolved }, { fable: 'claude-fable-5-1', opus: 'claude-opus-5-6', sonnet: 'claude-sonnet-5-5' });
  // (b) The model a turn's system/init event reports for an alias replaces the table entry from the next status read.
  const b = await fixture(t);
  const init = (model: string) => line({ type: 'system', subtype: 'init', cwd: 'C:\\x', session_id: SESSION, tools: [], mcp_servers: [], model, permissionMode: 'default', apiKeySource: 'none', claude_code_version: '2.1.301' });
  b.scripts.push(replay(init('claude-sonnet-5-7[1m]'), result()));
  await b.done((await b.host.send(turnInput('Hi there'))).turnId);
  assert.equal((await b.host.status()).resolved.sonnet, 'claude-sonnet-5-7', 'the context-size suffix is not part of the id');
  // A reported model of another family (or not a Claude id) is never attributed to the alias.
  b.scripts.push(replay(init('claude-opus-9-9'), result()), replay(init('gpt-5'), result()));
  await b.done((await b.host.send(turnInput('Again'))).turnId); await b.done((await b.host.send(turnInput('Once more'))).turnId);
  assert.equal((await b.host.status()).resolved.sonnet, 'claude-sonnet-5-7');
  assert.deepEqual(chat.resolveAliases(['opusplan', 'mystery'], [], new Map()), {}, 'aliases without evidence stay unresolved');
});

test('preload passes resolved model ids only for reported aliases and only as Claude model ids', async () => {
  const vm = await import('node:vm');
  const source = await readFile(join(process.cwd(), 'apps/desktop/electron/preload.cjs'), 'utf8');
  let exposed: any, reply: unknown = null;
  // Replies are built inside the preload's realm, as Electron's structured clone delivers them.
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async () => vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(reply)) + ')', context) } }) });
  vm.runInContext(source, context);
  const base = { installed: true, signedIn: true, cliVersion: '2.1.301', models: ['fable', 'opus'], efforts: ['high'], defaultModel: 'opus', message: null };
  const status = async (value: unknown) => { reply = value; return JSON.parse(JSON.stringify(await exposed.claudeChat.status())); };
  assert.deepEqual((await status({ ...base, resolved: { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5' } })).resolved, { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5' });
  assert.deepEqual((await status(base)).resolved, {}, 'older engines without the field still pass');
  for (const resolved of [{ haiku: 'claude-haiku-5-5' }, { opus: 'Opus 5.5' }, { opus: 'claude-opus-5-5 https://x' }, ['claude-opus-5-5'], null])
    await assert.rejects(status({ ...base, resolved }), /unavailable/i, JSON.stringify(resolved));
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
  assert.equal(run!.command, f.command); assert.equal(run!.options.cwd, f.project);
  assert.deepEqual(run!.args.slice(0, -2), ['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', join(f.root, 'arcane.mcp.json'), '--strict-mcp-config', '--setting-sources', 'user', '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'default',
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
  if (process.platform === 'win32') {
    assert.deepEqual(killer?.args, ['/T', '/F', '/PID', '4242']); assert.equal(killer?.command, 'C:\\Windows\\System32\\taskkill.exe');
  } else assert.equal(killer, undefined, 'Non-Windows hosts stop only their owned child.');
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
  assert.equal((await f.done(c.turnId)).error, chat.CLAUDE_CHAT_MESSAGES.exited);
  assert.match(chat.CLAUDE_CHAT_MESSAGES.exited, /stopped unexpectedly[\s\S]*retry/);
});

test('expired sign-in, outages, an offline Studio and a services restart become fixed messages with a next step', async t => {
  const f = await fixture(t), M = chat.CLAUDE_CHAT_MESSAGES;
  f.scripts.push(child => { child.write(init()); child.write(result({ subtype: 'error_during_execution', is_error: true, api_error_status: 401, result: 'OAuth token has expired' })); child.close(1); });
  const a = await f.host.send(turnInput('go'));
  assert.equal((await f.done(a.turnId)).error, M.authExpired);
  f.scripts.push(child => { child.write(init()); child.write(result({ subtype: 'error_during_execution', is_error: true, result: 'Invalid API key · Please run /login' })); child.close(1); });
  const b = await f.host.send(turnInput('go', a.conversationId));
  assert.equal((await f.done(b.turnId)).error, M.authExpired);
  f.scripts.push(child => { child.write(init()); child.write(result({ subtype: 'error_during_execution', is_error: true, api_error_status: 529, result: 'Overloaded' })); child.close(1); });
  const c = await f.host.send(turnInput('go', a.conversationId));
  assert.equal((await f.done(c.turnId)).error, M.network);
  // No result at all, only the CLI's own assistant error marker before it exits.
  f.scripts.push(child => { child.write(init()); child.write(line({ type: 'assistant', error: 'authentication_failed', message: { content: [] }, parent_tool_use_id: null, session_id: SESSION })); child.close(1); });
  const d = await f.host.send(turnInput('go', a.conversationId));
  assert.equal((await f.done(d.turnId)).error, M.authExpired);
  for (const key of ['authExpired', 'network', 'studioOffline', 'interrupted', 'exited', 'start']) assert.match(M[key], /retry/i, key);
  // The first SESSION_OFFLINE refusal stops the reply, so no further command reaches the offline session.
  const offline = JSON.stringify({ error: { code: 'SESSION_OFFLINE', message: 'Studio session is not live.' } });
  f.scripts.push(child => {
    child.write(init()); child.write(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__arcane__scene_create', input: {} }]));
    child.write(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: offline }], is_error: true }] }, parent_tool_use_id: null, session_id: SESSION }));
  });
  const e = await f.host.send(turnInput('go', a.conversationId));
  const done = await f.done(e.turnId);
  assert.deepEqual([done.ok, done.error], [false, M.studioOffline]);
  assert.ok(f.turns().at(-1)!.child.killed >= 1);
  // A host disposed for a services restart records the running reply as interrupted (never resent).
  f.scripts.push(child => { child.write(init()); });
  const g = await f.host.send(turnInput('go', a.conversationId));
  await waitFor(() => f.turns().length === 6);
  await f.host.dispose('interrupted');
  assert.equal((await f.done(g.turnId)).error, M.interrupted);
  assert.equal(f.turns().length, 6, 'Nothing was spawned again.');
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
  // Reply text that echoes the project credential (e.g. a tool result repeated by the model) is never shown or stored.
  f.scripts.push(replay(init(), delta('tok ' + CREDENTIAL), assistant([{ type: 'text', text: 'tok ' + CREDENTIAL }]), result()));
  const d = await f.host.send(turnInput('go', a.conversationId));
  await f.done(d.turnId);
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
  assert.deepEqual([...handlers.keys()].sort(), ['history', 'list', 'remove', 'rewind', 'send', 'status', 'stop'].map(a => 'arcane:claude-chat-' + a));
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

test('tool events carry bounded display details: input and result JSON without script sources, persisted with the transcript', async t => {
  const f = await fixture(t);
  const ref = { instanceId: 'i1', sessionId: 's', root: 'ServerScriptService', pathSegments: ['Spawner'], className: 'Script' };
  const source = 'print("spawn")\n'.repeat(50);
  const outcome = { commandId: 'cmd-1', state: 'succeeded', terminal: true, command: { method: 'script.update', args: { ref, expectedSource: '', source }, result: null } };
  const resultLine = (id: string, content: unknown, isError = false) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null, session_id: SESSION });
  f.scripts.push(replay(init(),
    assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__arcane__script_update', input: { sessionId: 's', ref, expectedSource: '', source } }]),
    resultLine('toolu_1', [{ type: 'text', text: JSON.stringify(outcome) }]),
    assistant([{ type: 'tool_use', id: 'toolu_2', name: 'mcp__arcane__scene_update', input: { big: 'x'.repeat(9000).split('').map((_, i) => i) } }]),
    resultLine('toolu_2', 'Studio is not\u0007 in edit mode.\n' + CREDENTIAL, true), result()));
  const reply = await f.host.send(turnInput('Update the spawner'));
  await f.done(reply.turnId);
  const tools = f.events.filter(e => e.type === 'tool').map(e => e.message.tool);
  assert.deepEqual(JSON.parse(tools[0].input), { sessionId: 's', ref, expectedSource: '[0 characters]', source: '[' + source.length + ' characters]' }, 'sources become their length');
  assert.equal(tools[0].result, undefined, 'a started tool has no result yet');
  assert.deepEqual(JSON.parse(tools[1].result).command.args.source, '[' + source.length + ' characters]');
  assert.equal(JSON.parse(tools[1].result).commandId, 'cmd-1'); assert.equal(tools[1].input, tools[0].input, 'the finished event keeps the input');
  assert.equal(tools[2].input, undefined, 'oversized input is omitted, never cut');
  assert.equal(tools[3].status, 'failed'); assert.equal(tools[3].result, undefined, 'a result that contains the scoped credential is never forwarded');
  for (const tool of tools) for (const value of [tool.input, tool.result]) assert.ok(value === undefined || value.length <= 4096 && !value.includes(CREDENTIAL));
  const history = await f.host.history(reply.conversationId);
  assert.deepEqual(history.messages.filter((m: any) => m.tool).map((m: any) => m.tool), [tools[1], tools[3]], 'the transcript keeps the final details');
  // A fresh host reads the same details back from disk.
  const again = await fixture(t, { directory: f.state });
  assert.deepEqual((await again.host.history(reply.conversationId)).messages.filter((m: any) => m.tool).map((m: any) => m.tool), [tools[1], tools[3]]);
});

test('preload forwards tool details only as bounded strings', async () => {
  const vm = await import('node:vm');
  const source = await readFile(join(process.cwd(), 'apps/desktop/electron/preload.cjs'), 'utf8');
  let exposed: any; const listeners: ((event: unknown, payload: unknown) => void)[] = [];
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
    ipcRenderer: { on: (_channel: string, fn: any) => listeners.push(fn), removeListener() {}, invoke: async () => null } }) });
  const seen: any[] = []; exposed.claudeChat.onEvent((event: unknown) => seen.push(event));
  const send = (tool: Record<string, unknown>) => { seen.length = 0; listeners[0]!({}, { turnId: randomUUID(), conversationId: randomUUID(), type: 'tool',
    message: { id: randomUUID(), role: 'tool', text: 'scene_create', at: '2026-10-17T00:00:00.000Z', tool: { name: 'scene_create', status: 'finished', ...tool } } }); return seen[0] ? JSON.parse(JSON.stringify(seen[0].message.tool)) : null; };
  assert.deepEqual(send({ input: '{"name":"A"}', result: '{"commandId":"c"}', extra: 'dropped' }), { name: 'scene_create', status: 'finished', input: '{"name":"A"}', result: '{"commandId":"c"}' });
  assert.deepEqual(send({}), { name: 'scene_create', status: 'finished' }, 'older engines send no details');
  assert.equal(send({ input: 'x'.repeat(4097) }), null);
  assert.equal(send({ result: { commandId: 'c' } }), null);
});

test('edit rewind: the edited message and everything after it are removed and persisted; the next turn is a fresh seeded session', async t => {
  const f = await fixture(t);
  f.scripts.push(replay(init(), assistant([{ type: 'text', text: 'Plan A ready' }]), result()),
    replay(init(), assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__arcane__scene_create', input: { name: 'Door' } }]), toolResult('toolu_1'), assistant([{ type: 'text', text: 'Built the door' }]), result()));
  const first = await f.host.send(turnInput('Make a lobby'));
  assert.match(first.messageId, /^[0-9a-f-]{36}$/, 'send returns the saved user message id');
  await f.done(first.turnId);
  const second = await f.host.send(turnInput('Add a red door', first.conversationId)); await f.done(second.turnId);
  assert.deepEqual(f.turns()[1]!.args.slice(-2), ['--resume', SESSION]);
  const saved = (await f.host.history(first.conversationId)).messages;
  assert.deepEqual(saved.map((m: any) => m.text), ['Make a lobby', 'Plan A ready', 'Add a red door', 'scene_create', 'Built the door']);
  assert.equal(saved[2].id, second.messageId);
  // Only a saved user message can be the rewind point; malformed envelopes fail closed.
  await assert.rejects(f.host.rewind({ conversationId: first.conversationId, messageId: saved[1].id }), { message: 'This message can no longer be edited.' });
  await assert.rejects(f.host.rewind({ conversationId: first.conversationId, messageId: randomUUID() }), { message: 'This message can no longer be edited.' });
  await assert.rejects(f.host.rewind({ conversationId: randomUUID(), messageId: second.messageId }), /no longer exists/);
  for (const bad of [{ conversationId: first.conversationId }, { conversationId: first.conversationId, messageId: 'x' }, { conversationId: first.conversationId, messageId: second.messageId, extra: 1 }])
    await assert.rejects(f.host.rewind(bad), /unavailable/);
  const rewound = await f.host.rewind({ conversationId: first.conversationId, messageId: second.messageId });
  assert.deepEqual({ ...rewound }, { conversationId: first.conversationId, kept: 2 });
  assert.deepEqual((await f.host.history(first.conversationId)).messages.map((m: any) => m.text), ['Make a lobby', 'Plan A ready']);
  // Persisted: a fresh host reads the shorter transcript and the rewound flag from disk.
  const again = await fixture(t, { directory: f.state });
  assert.deepEqual((await again.host.history(first.conversationId)).messages.map((m: any) => m.text), ['Make a lobby', 'Plan A ready']);
  const index = JSON.parse(await readFile(join(f.state, 'index.json'), 'utf8'));
  assert.deepEqual([index.conversations[0].sessionId, index.conversations[0].rewound], [null, true]);
  // The edited message: no --resume (the CLI has no resume-at), and the kept transcript seeds the fresh session on stdin.
  const fresh = 'aaaaaaaa-6d33-4477-8247-a08f685e2c29';
  again.scripts.push(replay(init(fresh), assistant([{ type: 'text', text: 'Blue door built' }]), result({ session_id: fresh })),
    replay(init(fresh), assistant([{ type: 'text', text: 'ok' }]), result({ session_id: fresh })));
  const edited = await again.host.send(turnInput('Add a blue door', first.conversationId)); await again.done(edited.turnId);
  const [run] = again.turns();
  assert.ok(!run!.args.includes('--resume') && !run!.args.includes('--fork-session'));
  assert.equal(run!.child.input, chat.rewindSeed([{ role: 'user', text: 'Make a lobby' }, { role: 'assistant', text: 'Plan A ready' }]) + 'Add a blue door');
  assert.match(run!.child.input, /fresh Claude Code session[\s\S]*User: Make a lobby\n\nAssistant: Plan A ready\n<\/earlier-conversation>[\s\S]*Add a blue door$/);
  assert.ok(!run!.child.input.includes('red door'), 'discarded turns never reach the model');
  assert.deepEqual((await again.host.history(first.conversationId)).messages.map((m: any) => m.text), ['Make a lobby', 'Plan A ready', 'Add a blue door', 'Blue door built']);
  // Later turns resume the new session without a seed.
  const next = await again.host.send(turnInput('Thanks', first.conversationId)); await again.done(next.turnId);
  assert.deepEqual(again.turns()[1]!.args.slice(-2), ['--resume', fresh]); assert.equal(again.turns()[1]!.child.input, 'Thanks');
  // A running reply blocks a rewind of the same conversation.
  again.scripts.push(child => { child.write(init(fresh)); });
  const running = await again.host.send(turnInput('One more', first.conversationId));
  await assert.rejects(again.host.rewind({ conversationId: first.conversationId, messageId: next.messageId }), /still running/);
  await again.host.stop(running.turnId); await again.done(running.turnId);
});

test('the system prompt asks for arcane-choices and arcane-plan blocks; preload validates the rewind envelope and replies', async t => {
  const f = await fixture(t);
  f.scripts.push(replay(init(), result()));
  await f.done((await f.host.send(turnInput('Hi'))).turnId);
  const prompt = f.turns()[0]!.args.at(-1)!;
  assert.match(prompt, /arcane-choices[\s\S]*\{"question":"\.\.\.","options":\["\.\.\.","\.\.\."\]\}[\s\S]*arcane-plan[\s\S]*\{"steps":\[/);
  assert.ok(prompt.indexOf('arcane-choices') < prompt.indexOf('ARCANE TASK INSTRUCTIONS FIXTURE'), 'the preamble comes first so it survives the length bound');
  const vm = await import('node:vm');
  const source = await readFile(join(process.cwd(), 'apps/desktop/electron/preload.cjs'), 'utf8');
  let exposed: any, reply: unknown = null; const invoked: unknown[][] = [];
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async (...args: unknown[]) => { invoked.push(args); return vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(reply)) + ')', context); } } }) });
  vm.runInContext(source, context);
  // Arguments are built in the preload's realm, as the renderer's world hands them over.
  const inner = (value: unknown) => vm.runInContext('(' + JSON.stringify(value) + ')', context);
  const conversationId = randomUUID(), messageId = randomUUID();
  reply = { conversationId, kept: 3 };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.claudeChat.rewind(inner({ conversationId, messageId })))), { conversationId, kept: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(invoked.at(-1))), ['arcane:claude-chat-rewind', { conversationId, messageId }]);
  const count = invoked.length;
  for (const bad of [[], [inner({ conversationId })], [inner({ conversationId, messageId: 'x' })], [inner({ conversationId, messageId, text: 'x' })], [inner({ conversationId, messageId }), 1]])
    await assert.rejects(exposed.claudeChat.rewind(...bad), /unavailable/);
  assert.equal(invoked.length, count, 'malformed rewinds never reach the main process');
  for (const bad of [{ conversationId, kept: -1 }, { conversationId, kept: 1.5 }, { conversationId: 'x', kept: 1 }]) { reply = bad; await assert.rejects(exposed.claudeChat.rewind(inner({ conversationId, messageId })), /unavailable/); }
  const turnId = randomUUID(), request = inner({ conversationId, text: 'x', model: 'sonnet', effort: 'high' });
  reply = { turnId, conversationId, messageId };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.claudeChat.send(request))), { turnId, conversationId, messageId });
  reply = { turnId, conversationId };
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.claudeChat.send(request))), { turnId, conversationId }, 'older engines omit the id');
  reply = { turnId, conversationId, messageId: 'not-an-id' };
  await assert.rejects(exposed.claudeChat.send(request), /unavailable/);
});

// A real 1x1 PNG (the same bytes used for the recorded Claude Code 2.1.302 stream-json input smoke run).
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngRef = (name = 'ref.png', data = PNG_1X1) => ({ name, dataUrl: 'data:image/png;base64,' + data });

test('PNG references go to Claude Code as one stream-json user message; the transcript keeps only image markers', async t => {
  const f = await fixture(t);
  f.scripts.push(replay(init(), assistant([{ type: 'text', text: 'OK' }]), result()));
  const reply = await f.host.send({ ...turnInput('Reply with OK'), images: [pngRef('door.png'), pngRef('wall.png')] });
  assert.equal((await f.done(reply.turnId)).ok, true);
  const [run] = f.turns();
  assert.deepEqual(run!.args.slice(0, 4), ['-p', '--input-format', 'stream-json', '--output-format']);
  assert.ok(run!.child.input.endsWith('\n') && run!.child.input.trim().split('\n').length === 1, 'exactly one NDJSON line');
  // The observed Claude Code input shape: {type:'user', message:{role:'user', content:[image blocks..., text block]}}.
  assert.deepEqual(JSON.parse(run!.child.input), { type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
    { type: 'text', text: 'Reply with OK' }] } });
  assert.equal(chat.streamJsonMessage(chat.sendInput({ ...turnInput('Reply with OK'), images: [pngRef('door.png'), pngRef('wall.png')] }).images, 'Reply with OK'), run!.child.input);
  const history = await f.host.history(reply.conversationId);
  assert.equal(history.messages[0].text, 'Reply with OK\n\n[image: door.png] [image: wall.png]');
  // Nothing under the state directory holds the image bytes.
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full); } };
  await walk(f.state);
  assert.ok(files.length > 0);
  for (const file of files) assert.ok(!(await readFile(file, 'utf8')).includes(PNG_1X1.slice(0, 40)), file);
  // A plain text turn after it keeps the text input format.
  f.scripts.push(replay(init(), result()));
  await f.done((await f.host.send(turnInput('Thanks', reply.conversationId))).turnId);
  assert.deepEqual(f.turns()[1]!.args.slice(0, 3), ['-p', '--input-format', 'text']); assert.equal(f.turns()[1]!.child.input, 'Thanks');
});

test('image references are validated in the main process: PNG signature, canonical base64, count and the 512 KiB total', async t => {
  const f = await fixture(t);
  const big = (bytes: number) => { const buffer = Buffer.alloc(bytes); Buffer.from(PNG_1X1, 'base64').copy(buffer); return buffer.toString('base64'); };
  const bad: unknown[] = [[], [pngRef(), pngRef(), pngRef(), pngRef(), pngRef()], [pngRef('ref.gif')], [pngRef('a/b.png')], [pngRef('..\\x.png')], [pngRef(' ref.png')],
    [{ name: 'ref.png', dataUrl: 'data:image/jpeg;base64,' + PNG_1X1 }], [pngRef('ref.png', Buffer.from('GIF89a'.repeat(12)).toString('base64'))],
    [pngRef('ref.png', PNG_1X1.slice(0, -2) + '=')], [pngRef('ref.png', PNG_1X1 + ' ')], [pngRef('ref.png', big(512 * 1024 + 1))],
    [pngRef('a.png', big(300 * 1024)), pngRef('b.png', big(300 * 1024))], [{ name: 'ref.png' }], [{ name: 'ref.png', dataUrl: 'data:image/png;base64,' + PNG_1X1, extra: 1 }],
    'ref.png', { 0: pngRef(), length: 1 }];
  for (const images of bad) await assert.rejects(f.host.send({ ...turnInput('Look'), images }), { message: chat.CLAUDE_CHAT_MESSAGES.images }, JSON.stringify(images).slice(0, 120));
  assert.equal(f.turns().length, 0, 'refused references start nothing');
  assert.deepEqual(await f.host.list(), { conversations: [] }, 'and save nothing');
  // Exactly at the bound is accepted (four references, 512 KiB in total).
  assert.equal(chat.sendInput({ ...turnInput('Look'), images: [1, 2, 3, 4].map(n => pngRef(n + '.png', big(128 * 1024))) }).images.length, 4);
  // The IPC boundary forwards the same refusal message; its validated copy re-validates in the host.
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<any>>();
  const frame = { url: ORIGIN + '/studio' }, contents = { isDestroyed: () => false, mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  const session = { window, origin: ORIGIN, epoch: {} };
  chat.installClaudeChatIpc({ handle: (channel: string, handler: any) => handlers.set(channel, handler) }, { getSession: () => session, getHost: () => f.host });
  const send = (input: unknown) => handlers.get('arcane:claude-chat-send')!({ sender: contents, senderFrame: frame }, input);
  await assert.rejects(send({ ...turnInput('Look'), images: [pngRef('ref.gif')] }), { message: chat.CLAUDE_CHAT_MESSAGES.images });
  f.scripts.push(replay(init(), result()));
  const reply = await send({ ...turnInput('Look'), images: [pngRef()] });
  await f.done(reply.turnId);
  assert.equal(JSON.parse(f.turns()[0]!.child.input).message.content[0].source.data, PNG_1X1);
});

test('preload forwards optional PNG references only as exact bounded records', async () => {
  const vm = await import('node:vm');
  const source = await readFile(join(process.cwd(), 'apps/desktop/electron/preload.cjs'), 'utf8');
  let exposed: any; const invoked: unknown[][] = []; const conversationId = randomUUID(), turnId = randomUUID();
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
    ipcRenderer: { on() {}, removeListener() {}, invoke: async (...args: unknown[]) => { invoked.push(args); return vm.runInContext('({ turnId: ' + JSON.stringify(turnId) + ', conversationId: ' + JSON.stringify(conversationId) + ' })', context); } } }) });
  vm.runInContext(source, context);
  const inner = (value: unknown) => vm.runInContext('(' + JSON.stringify(value) + ')', context);
  const base = { conversationId: null, text: 'Look', model: 'sonnet', effort: 'high' };
  await exposed.claudeChat.send(inner({ ...base, images: [pngRef()] }));
  assert.deepEqual(JSON.parse(JSON.stringify(invoked.at(-1))), ['arcane:claude-chat-send', { ...base, images: [pngRef()] }]);
  await exposed.claudeChat.send(inner(base));
  assert.deepEqual(JSON.parse(JSON.stringify(invoked.at(-1))), ['arcane:claude-chat-send', base], 'text-only sends are unchanged');
  const count = invoked.length;
  for (const images of [[], [pngRef(), pngRef(), pngRef(), pngRef(), pngRef()], [pngRef('ref.svg')], [{ name: 'ref.png', dataUrl: 'data:image/gif;base64,R0lG' }],
    [{ name: 'ref.png' }], [{ ...pngRef(), extra: 1 }], [pngRef('ref.png', 'A'.repeat(800000))], 'x'])
    await assert.rejects(exposed.claudeChat.send(inner({ ...base, images })), { message: chat.CLAUDE_CHAT_MESSAGES.images });
  assert.equal(invoked.length, count, 'malformed references never reach the main process');
});

test('saved project consent: auto-approve starts without a question; "Always allow" is remembered; switching off asks again', async t => {
  const auto = await fixture(t, { permissions: { claudeTools: async () => true, allowClaudeTools: async () => assert.fail('nothing to remember') } });
  auto.scripts.push(replay(init(), assistant([{ type: 'text', text: 'done' }]), result()));
  const a = await auto.host.send(turnInput('go')); assert.equal((await auto.done(a.turnId)).ok, true);
  assert.equal(auto.dialogs.length, 0, 'auto-approved: no consent question'); assert.equal(auto.turns().length, 1);
  let saved = 0, allowed = false;
  const ask = await fixture(t, { response: 2, permissions: { claudeTools: async () => allowed, allowClaudeTools: async () => { saved++; allowed = true; } } });
  ask.scripts.push(replay(init(), result()), replay(init(), result()), replay(init(), result()));
  const b = await ask.host.send(turnInput('go')); await ask.done(b.turnId);
  assert.equal(ask.dialogs.length, 1); assert.deepEqual(ask.dialogs[0].buttons, ['Cancel', 'Allow', 'Always allow']);
  assert.equal(ask.dialogs[0].defaultId, 0); assert.equal(ask.dialogs[0].cancelId, 0); assert.match(ask.dialogs[0].detail, /Settings > Permissions/);
  assert.equal(saved, 1, '"Always allow" saves the project switch');
  ask.host.revokeApproval();
  assert.equal(ask.released.length, 1, 'switching off revokes the idle shared credential at once');
  allowed = false;
  const c = await ask.host.send(turnInput('again', b.conversationId)); await ask.done(c.turnId);
  assert.equal(ask.dialogs.length, 2, 'asks again after the switch went off');
  const failing = await fixture(t, { response: 0, permissions: { claudeTools: async () => { throw new Error('disk'); } } });
  const d = await failing.host.send(turnInput('go')); assert.equal((await failing.done(d.turnId)).error, chat.CLAUDE_CHAT_MESSAGES.declined);
  assert.equal(failing.dialogs.length, 1, 'an unreadable setting falls back to asking'); assert.deepEqual(failing.dialogs[0].buttons, ['Cancel', 'Allow']);
});

test('credential renewal: a credential that cannot cover a full reply is replaced transparently and the old one revoked', async t => {
  const f = await fixture(t, { expiresInMs: 20 * 60000, permissions: { claudeTools: async () => true } });
  f.scripts.push(replay(init(), result()), replay(init(), result()));
  const a = await f.host.send(turnInput('one')); assert.equal((await f.done(a.turnId)).ok, true);
  assert.equal(f.released.length, 1, 'an idle credential below the reuse floor is revoked after the reply');
  const b = await f.host.send(turnInput('two', a.conversationId)); assert.equal((await f.done(b.turnId)).ok, true);
  assert.equal(f.prepared.length, 2, 'the next reply minted a fresh scoped credential without asking');
  assert.equal(f.dialogs.length, 0);
  const fresh = await fixture(t, { permissions: { claudeTools: async () => true } });
  fresh.scripts.push(replay(init(), result()), replay(init(), result()));
  const c = await fresh.host.send(turnInput('one')); await fresh.done(c.turnId);
  const d = await fresh.host.send(turnInput('two', c.conversationId)); await fresh.done(d.turnId);
  assert.equal(fresh.prepared.length, 1, 'a fresh credential is reused while it still covers a full reply'); assert.equal(fresh.released.length, 0);
  assert.ok(chat.CLAUDE_CHAT_LIMITS.turnTimeoutMs - chat.CLAUDE_CHAT_LIMITS.credentialReuseMs > chat.CLAUDE_CHAT_LIMITS.credentialMarginMs);
});

test('the appended system prompt is identical on every turn; the Playtest switch rides on the user message', async t => {
  const f = await fixture(t);
  f.scripts.push(replay(init(), result()), replay(init(), result()), replay(init(), result()));
  const first = await f.host.send({ ...turnInput('Build a hut'), playtest: true }); await f.done(first.turnId);
  const second = await f.host.send({ ...turnInput('Now a fence', first.conversationId), playtest: false }); await f.done(second.turnId);
  const third = await f.host.send(turnInput('And a gate', first.conversationId)); await f.done(third.turnId);
  // A byte-identical system prompt keeps Claude Code's cached prefix (system prompt and tools) reusable across turns.
  const prompts = f.turns().map(run => run.args[run.args.indexOf('--append-system-prompt') + 1]);
  assert.equal(prompts.length, 3); assert.equal(new Set(prompts).size, 1, 'one cacheable system prompt');
  assert.doesNotMatch(prompts[0]!, /Playtest is|\d{4}-\d{2}-\d{2}T\d{2}:/);
  assert.deepEqual(f.turns().map(run => run.child.input), ['Build a hut' + chat.playtestNote(true), 'Now a fence' + chat.playtestNote(false), 'And a gate']);
  // Project memory guidance always follows the static instructions; ARCANE.md changes the prompt only when the file changes.
  assert.ok(prompts[0]!.endsWith(chat.projectMemorySection('')), 'memory section comes last');
  assert.ok(prompts[0]!.indexOf('ARCANE TASK INSTRUCTIONS FIXTURE') < prompts[0]!.indexOf('arcane-memory'));
  await writeFile(join(f.project, 'ARCANE.md'), '# Style\r\nLow-poly, warm palette.\n');
  f.scripts.push(replay(init(), result()), replay(init(), result()));
  const fourth = await f.host.send(turnInput('A well', first.conversationId)); await f.done(fourth.turnId);
  const fifth = await f.host.send(turnInput('A bucket', first.conversationId)); await f.done(fifth.turnId);
  const later = f.turns().slice(3).map(run => run.args[run.args.indexOf('--append-system-prompt') + 1]);
  assert.equal(later[0], later[1], 'unchanged memory keeps one cacheable prompt');
  assert.equal(later[0], prompts[0]!.slice(0, prompts[0]!.length - chat.projectMemorySection('').length) + chat.projectMemorySection('# Style\nLow-poly, warm palette.'));
  assert.match(later[0]!, /<project-memory>\n# Style\nLow-poly, warm palette\.\n<\/project-memory>$/);
  // Managed task instructions that already describe @selection and the choice/plan blocks are not repeated by the preamble.
  const managed = chat.appendedSystemPrompt('Rules. Use one fenced block in language arcane-choices when the user must decide.');
  assert.equal(managed.match(/arcane-choices/g).length, 1);
  assert.match(managed, /^You are running inside the Arcane desktop chat[^\n]*concise Markdown\.\n\nRules\./);
  const fallback = chat.appendedSystemPrompt('ARCANE TASK INSTRUCTIONS FIXTURE');
  assert.match(fallback, /selection_read[\s\S]*arcane-choices[\s\S]*arcane-plan[\s\S]*FIXTURE$/, 'other instructions keep the full preamble');
  assert.match(fallback, /an explicit build request needs no plan approval/, 'the fallback never makes every build wait for plan approval');
});
