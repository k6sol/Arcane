import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCodexDiscoveryProcess, prepareCodexProcess } from '../../packages/codex-client/src/mcp-profile.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
// Include the exact public factory in scoped compiler inputs; importing it never launches a child.
import '../../packages/codex-client/src/index.js';

const TOKEN = 'a4'.repeat(32), AMBIENT = 'b5'.repeat(32);
const DAEMON = 'http://127.0.0.1:47831';
const MODULES = ['index', 'mcp-profile', 'mcp-isolation', 'session', 'transport', 'types', 'validation', 'history'];
const EMITTED = fileURLToPath(new URL('../../packages/codex-client/src/', import.meta.url));
type Mode = 'normal' | 'discovery-init-failure' | 'inventory-failure' | 'unsafe-key' |
  'arcane-active' | 'arcane-missing' | 'arcane-null' | 'arcane-plugin' | 'arcane-metadata' | 'final-init-failure' | 'final-inherited' | 'final-null';
type HistoryAction = 'non-human' | 'foreign-thread' | 'foreign-session' | 'invalid-id' | 'extra-field' | 'disconnected' | 'close-pending' | 'busy-pending';
type HistoryResponse = 'wrong-thread' | 'wrong-session' | 'wrong-project';
interface FixtureOptions {
  profile?: boolean; mode?: Mode; thread?: boolean; history?: boolean; invalidProfile?: boolean;
  historyAction?: HistoryAction; historyResponse?: HistoryResponse; repeatHistory?: boolean;
}
interface Receipt {
  event: string; launch?: number; args?: string[]; envKeys?: string[]; tokenHash?: string | null;
  daemonUrl?: string | null; method?: string; params?: Record<string, unknown>; cwd?: string; envHasEntry?: boolean;
  code?: string; snapshot?: { ready: boolean; mcpIsolation: string; thread: { threadId: string; configured: boolean } | null };
  history?: { completeness: string; entries: { text: string; ids: { threadId: string; sessionId: string | null; turnId: string; itemId: string } }[]; gaps: { reason: string }[] };
}

// The peer sees the actual fixed argv/env delivered to spawn, but never runs a CLI,
// MCP entry, inference, provider config/auth reader, HTTP request or Studio call.
const PEER = String.raw`
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [encoded, audit, ...args] = process.argv.slice(1), scenario = JSON.parse(encoded);
const launch = scenario.launch, mode = scenario.mode;
const record = value => appendFileSync(audit, JSON.stringify({ launch, ...value }) + '\n');
record({ event: 'child', args, cwd: process.cwd(), envKeys: Object.keys(process.env),
  envHasEntry: Object.values(process.env).some(value => value.includes(require('node:path').join(process.cwd(), 'apps', 'mcp', 'src', 'main.js'))),
  tokenHash: process.env.ARCANE_LOCAL_TOKEN ? createHash('sha256').update(process.env.ARCANE_LOCAL_TOKEN).digest('hex') : null,
  daemonUrl: process.env.ARCANE_DAEMON_URL || null });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ id, result: value });
const reject = id => send({ id, error: { code: -32017, message: 'Synthetic refusal' } });
const row = (name, runtimeStatus, pluginId = null) => ({ name, runtimeStatus, pluginId, toolsError: null, tools: {} });
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  record({ event: 'rpc', method, params });
  if (method === 'initialized') return;
  if (method === 'initialize') {
    if (mode === 'discovery-init-failure' && launch === 1 || mode === 'final-init-failure' && launch === 2) return reject(id);
    return result(id, {});
  }
  if (method === 'account/read') return result(id, { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true });
  if (method === 'model/list') return result(id, { data: [{ id: 'picker-fixture', model: 'fixture-model', displayName: 'Fixture',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null });
  if (method === 'mcpServerStatus/list') {
    if (launch === 1 && mode === 'inventory-failure') return reject(id);
    const discovery = launch === 1;
    let data = [row('arcane', discovery ? 'disabled' : 'connected'),
      row('inherited', discovery || mode === 'final-inherited' ? 'connected' : 'disabled'),
      row('plugin_server', discovery ? 'connected' : 'disabled', 'fixture-plugin@bundled')];
    if (discovery) {
      if (mode === 'unsafe-key') data[1].name = 'unsafe.dot';
      if (mode === 'arcane-active') data[0].runtimeStatus = 'connected';
      if (mode === 'arcane-null') data[0].runtimeStatus = null;
      if (mode === 'arcane-plugin') data[0].pluginId = 'fixture-plugin@bundled';
      if (mode === 'arcane-missing') data.shift();
      if (mode === 'arcane-metadata') delete data[0].pluginId;
    }
    if (!discovery && mode === 'final-null') data[0].runtimeStatus = null;
    return result(id, { data, nextCursor: null });
  }
  if (method === 'thread/start') return result(id, {
    thread: { id: 'fixture-thread', sessionId: 'fixture-session', turns: [], status: { type: 'idle' } },
    model: params.model, modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'on-request',
    approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } });
  if (method === 'thread/read') {
    if (scenario.historyAction === 'close-pending' || scenario.historyAction === 'busy-pending') {
      appendFileSync(audit + '.waiting', 'Synthetic read dispatched'); return;
    }
    const thread = { id: 'fixture-thread', sessionId: 'fixture-session', cwd: process.cwd(), ephemeral: false,
      turns: [{ id: 'fixture-turn', status: 'completed', items: [
        { type: 'agentMessage', id: 'fixture-item', phase: 'final_answer', text: 'Synthetic public history' }
      ] }] };
    if (scenario.historyResponse === 'wrong-thread') thread.id = 'foreign-thread';
    if (scenario.historyResponse === 'wrong-session') thread.sessionId = 'foreign-session';
    if (scenario.historyResponse === 'wrong-project') thread.cwd = require('node:path').join(process.cwd(), 'foreign-project');
    return result(id, { thread });
  }
  return reject(id);
});
`;

// Only the process boundary is redirected. Copy compiled product modules byte for
// byte into a private ESM tree so the bundled-entry trust check stays real, without
// writing shared dist or replacing the factory/profile/session/isolation logic.
const HARNESS = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const [root, audit, encoded] = process.argv.slice(2), scenario = JSON.parse(encoded);
const record = value => appendFileSync(audit, JSON.stringify(value) + '\n');
const library = pathToFileURL(join(root, 'packages', 'codex-client', 'src') + '/').href;
const boundary = pathToFileURL(join(root, 'boundary.mjs')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process' && context.parentURL?.startsWith(library)) return { url: boundary, shortCircuit: true };
  return nextResolve(specifier, context);
} });
process.env.ARCANE_LOCAL_TOKEN = 'b5'.repeat(32);
process.env.ARCANE_DAEMON_URL = 'http://127.0.0.1:49999';
process.env.ARCANE_AGENT_TOKEN = 'SYNTHETIC_OTHER_AUTHORITY';
process.env.CODEX_HOME = 'SYNTHETIC_PROVIDER_OVERRIDE';
process.env.OPENAI_API_KEY = 'SYNTHETIC_PROVIDER_KEY';
process.env.NODE_OPTIONS = '--require=SYNTHETIC_WRAPPER';
const { connectCodexClient } = await import(library + 'index.js');
let client;
try {
  const profile = { nodeExecutable: process.execPath, serverEntry: join(root, 'apps', 'mcp', 'src', 'main.js'),
    projectRoot: root, daemonUrl: 'http://127.0.0.1:47831', agentToken: 'a4'.repeat(32) };
  if (scenario.invalidProfile) profile.daemonUrl = 'https://example.test';
  client = await connectCodexClient({
    command: join(root, process.platform === 'win32' ? 'codex.exe' : 'codex'), cwd: root,
    use: 'personal-local', limits: { requestTimeoutMs: 5000 }, ...(scenario.profile ? { arcaneMcp: profile } : {})
  });
  record({ event: 'connected', snapshot: client.snapshot(), node: await realpath(process.execPath) });
  if (scenario.thread) {
    client.selectModel({ initiatedBy: 'human', model: 'fixture-model', effort: 'low' });
    await client.startThread({ initiatedBy: 'human' });
    record({ event: 'configured', snapshot: client.snapshot() });
  }
  if (scenario.history) {
    const action = { initiatedBy: 'human', threadId: 'fixture-thread', sessionId: 'fixture-session' };
    if (scenario.historyAction === 'non-human') action.initiatedBy = 'agent';
    if (scenario.historyAction === 'foreign-thread') action.threadId = 'foreign-thread';
    if (scenario.historyAction === 'foreign-session') action.sessionId = 'foreign-session';
    if (scenario.historyAction === 'invalid-id') action.threadId = 'invalid/thread';
    if (scenario.historyAction === 'extra-field') action.env = { ARCANE_LOCAL_TOKEN: 'SYNTHETIC_SPOOF' };
    if (scenario.historyAction === 'disconnected') await client.close();
    record({ event: 'history-before', snapshot: client.snapshot() });
    for (let attempt = 0; attempt < (scenario.repeatHistory ? 2 : 1); attempt++) {
      const settled = client.readThreadHistory(action).then(
        history => record({ event: 'history', history }),
        error => record({ event: 'history-error', code: error.code }));
      if (scenario.historyAction === 'close-pending' || scenario.historyAction === 'busy-pending') {
        const deadline = Date.now() + 3000;
        while (!existsSync(audit + '.waiting')) {
          if (Date.now() >= deadline) throw new Error('Synthetic history did not dispatch.');
          await delay(5);
        }
        if (scenario.historyAction === 'busy-pending') {
          try { await client.readThreadHistory(action); }
          catch (error) { record({ event: 'busy-error', code: error.code }); }
        }
        await client.close();
      }
      await settled;
    }
    record({ event: 'history-after', snapshot: client.snapshot() });
  }
} catch (error) { record({ event: 'error', code: error.code }); }
finally { await client?.close(); }
`;

async function privateDirectory(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arcane-codex-discovery-'));
  t.after(async () => {
    const root = await realpath(tmpdir()), actual = await realpath(dir), child = relative(root, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-codex-discovery-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  return dir;
}

async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const dir = await privateDirectory(t), audit = join(dir, 'audit.jsonl');
  const source = join(dir, 'packages', 'codex-client', 'src'), entry = join(dir, 'apps', 'mcp', 'src', 'main.js');
  await mkdir(source, { recursive: true });
  await mkdir(join(dir, 'apps', 'mcp', 'src'), { recursive: true });
  for (const name of MODULES) {
    await copyFile(join(EMITTED, name + '.js'), join(source, name + '.js'));
    assert.deepEqual(await readFile(join(source, name + '.js')), await readFile(join(EMITTED, name + '.js')));
  }
  const command = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await writeFile(command, 'Synthetic path-validation fixture; never executed.');
  await chmod(command, 0o700);
  await writeFile(entry, 'throw new Error("Synthetic entry; never executed.");');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'peer.cjs'), PEER);
  await writeFile(join(dir, 'harness.mjs'), HARNESS);
  const scenario = { mode: 'normal', profile: true, ...options };
  const boundary = [
    "import { spawn as realSpawn } from 'node:child_process';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const root = ' + JSON.stringify(dir) + ', audit = ' + JSON.stringify(audit) + ', scenario = ' + JSON.stringify(scenario) + ';',
    "const record = value => appendFileSync(audit, JSON.stringify(value) + '\\n');",
    "const peer = readFileSync(join(root, 'peer.cjs'), 'utf8'); let launch = 0;",
    'export function spawn(command, args, options) {',
    '  if (command !== ' + JSON.stringify(await realpath(command)) + ') throw new Error("Only the synthetic executable path is allowed.");',
    '  const id = ++launch; record({ event: "spawn", launch: id, args });',
    '  const child = realSpawn(process.execPath, ["-e", peer, JSON.stringify({ ...scenario, launch: id }), audit, ...args], options);',
    '  if (scenario.repeatHistory && id >= 3) { args.push("SYNTHETIC_BOUNDARY_MUTATION"); options.env.ARCANE_LOCAL_TOKEN = "b5".repeat(32); options.env.ARCANE_DAEMON_URL = "http://127.0.0.1:49999"; }',
    '  child.once("close", () => record({ event: "close", launch: id })); return child;',
    '}',
  ].join('\n');
  await writeFile(join(dir, 'boundary.mjs'), boundary);
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [join(dir, 'harness.mjs'), dir, audit, JSON.stringify(scenario)],
      { cwd: dir, env: nativeEnvironment(), shell: false, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Synthetic harness timed out.')); }, 20_000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', status => { clearTimeout(deadline); status === 0 ? accept() : reject(new Error(output || 'Synthetic harness failed.')); });
  });
  const records = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Receipt);
  assert.ok(!JSON.stringify(records).includes(TOKEN) && !JSON.stringify(records).includes(AMBIENT));
  return { records, dir, entry };
}

const events = (records: Receipt[], event: string) => records.filter(row => row.event === event);
const calls = (records: Receipt[], method: string) => records.filter(row => row.event === 'rpc' && row.method === method);

function assertSecretFree(row: Receipt) {
  assert.equal(row.tokenHash, null);
  assert.equal(row.daemonUrl, null);
  assert.equal(row.envHasEntry, false);
  for (const key of row.envKeys ?? []) assert.ok(!key.toLowerCase().startsWith('arcane_'));
  for (const key of ['CODEX_HOME', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.ok(!row.envKeys?.includes(key));
  assert.ok(!JSON.stringify(row.args).includes(TOKEN));
}

test('no-profile public factory leaves launch and generic history helper behavior untouched', async t => {
  const { records } = await fixture(t, { profile: false, history: true });
  const children = events(records, 'child');
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.deepEqual(child.args, ['app-server', '--listen', 'stdio://']);
    assertSecretFree(child);
  }
  assert.equal(calls(records, 'mcpServerStatus/list').length, 0);
  assert.equal(events(records, 'connected')[0]?.snapshot?.mcpIsolation, 'native-config');
  assert.equal(events(records, 'history')[0]?.history?.completeness, 'complete');
  assert.equal(events(records, 'history')[0]?.history?.entries[0]?.text, 'Synthetic public history');
  assert.equal(calls(records, 'thread/read').length, 1);
});

test('discovery gets no inherited authority; final retains fixed authority, exact isolation and secret-free argv', async t => {
  const { records, dir, entry } = await fixture(t, { thread: true, history: true });
  const children = events(records, 'child'), discovery = children[0]!, final = children[1]!, helper = children[2]!;
  assert.equal(children.length, 3);
  assertSecretFree(discovery);
  assert.deepEqual(discovery.args, prepareCodexDiscoveryProcess('unused', 'unused').args);
  assert.ok(discovery.args?.[4]?.endsWith('enabled=false,enabled_tools=[]}'));
  assert.ok(!JSON.stringify(discovery.args).includes(entry) && !JSON.stringify(discovery.args).includes(DAEMON));
  assert.equal(final.tokenHash, createHash('sha256').update(TOKEN).digest('hex'));
  assert.equal(final.daemonUrl, DAEMON);
  const expected = await prepareCodexProcess('unused', dir, {
    nodeExecutable: process.execPath, serverEntry: entry, projectRoot: dir, daemonUrl: DAEMON, agentToken: TOKEN
  }, entry);
  assert.deepEqual(final.args?.slice(0, expected.args.length), expected.args);
  assert.deepEqual(final.args?.slice(expected.args.length), [
    '-c', 'mcp_servers.inherited={command=' + JSON.stringify(process.execPath) + ',args=["-e","process.exit(0)"],enabled=false,enabled_tools=[]}',
    '-c', 'plugins.fixture-plugin@bundled.mcp_servers.plugin_server.enabled=false',
    '-c', 'plugins.fixture-plugin@bundled.mcp_servers.plugin_server.enabled_tools=[]',
  ]);
  const close = records.findIndex(row => row.event === 'close' && row.launch === 1);
  const spawn = records.findIndex(row => row.event === 'spawn' && row.launch === 2);
  assert.ok(close >= 0 && spawn > close, 'discovery process closes before the final process is spawned');
  assert.equal(events(records, 'configured')[0]?.snapshot?.mcpIsolation, 'arcane-only-verified');
  assert.equal(events(records, 'configured')[0]?.snapshot?.thread?.threadId, 'fixture-thread');
  assertSecretFree(helper);
  assert.deepEqual(helper.args, [...discovery.args!, ...final.args!.slice(expected.args.length)]);
  assert.ok(!JSON.stringify(helper.args).includes(entry) && !JSON.stringify(helper.args).includes(DAEMON));
  assert.equal(helper.cwd, await realpath(dir));
  assert.equal(events(records, 'history-error').length, 0);
  assert.equal(events(records, 'history')[0]?.history?.completeness, 'complete');
  assert.deepEqual(events(records, 'history')[0]?.history?.entries, [{
    text: 'Synthetic public history',
    ids: { threadId: 'fixture-thread', sessionId: 'fixture-session', turnId: 'fixture-turn', itemId: 'fixture-item' },
    role: 'assistant',
  }]);
  assert.deepEqual(calls(records, 'thread/read').map(row => row.params), [{ threadId: 'fixture-thread', includeTurns: true }]);
  assert.deepEqual(records.filter(row => row.event === 'rpc' && row.launch === 3).map(row => row.method),
    ['initialize', 'initialized', 'thread/read']);
  assert.deepEqual(events(records, 'history-after')[0]?.snapshot, events(records, 'history-before')[0]?.snapshot);
  assert.equal(calls(records, 'thread/resume').length, 0);
  assert.deepEqual(calls(records, 'mcpServerStatus/list').map(row => row.params), [
    { cursor: null, limit: 4, detail: 'toolsAndAuthOnly' },
    { cursor: null, limit: 4, detail: 'toolsAndAuthOnly', threadId: 'fixture-thread' },
  ]);
  assert.equal(calls(records, 'turn/start').length, 0);
});

for (const [mode, expected] of [
  ['discovery-init-failure', 'REMOTE_REJECTED'], ['inventory-failure', 'REMOTE_REJECTED'],
  ['unsafe-key', 'MCP_ISOLATION'], ['arcane-active', 'MCP_ISOLATION'],
  ['arcane-missing', 'MCP_ISOLATION'], ['arcane-plugin', 'MCP_ISOLATION'],
  ['arcane-metadata', 'MCP_INVENTORY'],
] as const) {
  test(mode + ' closes secret-free discovery and never launches a fallback/final child', async t => {
    const { records } = await fixture(t, { mode });
    assert.equal(events(records, 'error')[0]?.code, expected);
    assert.equal(events(records, 'spawn').length, 1);
    assert.equal(events(records, 'close').length, 1);
    assert.equal(events(records, 'connected').length, 0);
    assertSecretFree(events(records, 'child')[0]!);
    assert.equal(calls(records, 'thread/start').length, 0);
  });
}

test('secret-free discovery may report no runtime yet, but connection remains pending until exact-thread verification', async t => {
  const { records } = await fixture(t, { mode: 'arcane-null' });
  assert.equal(events(records, 'error').length, 0);
  assert.equal(events(records, 'spawn').length, 2);
  assertSecretFree(events(records, 'child')[0]!);
  assert.equal(events(records, 'connected')[0]?.snapshot?.mcpIsolation, 'arcane-only-pending');
  assert.equal(events(records, 'connected')[0]?.snapshot?.thread, null);
  assert.equal(calls(records, 'thread/start').length, 0);
  assert.equal(calls(records, 'turn/start').length, 0);
});

test('null exact-thread runtime is not isolation proof and refuses configuration without inference', async t => {
  const { records } = await fixture(t, { mode: 'final-null', thread: true });
  assert.equal(events(records, 'error')[0]?.code, 'MCP_ISOLATION');
  assert.equal(events(records, 'spawn').length, 2);
  assert.equal(events(records, 'close').length, 2);
  assert.equal(events(records, 'configured').length, 0);
  assert.equal(calls(records, 'thread/start').length, 1);
  assert.equal(calls(records, 'turn/start').length, 0);
});

test('final initialization failure closes both incarnations with no fallback', async t => {
  const { records } = await fixture(t, { mode: 'final-init-failure' });
  assert.equal(events(records, 'error')[0]?.code, 'REMOTE_REJECTED');
  assert.equal(events(records, 'spawn').length, 2);
  assert.equal(events(records, 'close').length, 2);
  assert.equal(events(records, 'connected').length, 0);
  assert.equal(calls(records, 'thread/start').length, 0);
});

test('final exact-thread isolation still refuses inherited tools without replay or inference', async t => {
  const { records } = await fixture(t, { mode: 'final-inherited', thread: true });
  assert.equal(events(records, 'error')[0]?.code, 'MCP_ISOLATION');
  assert.equal(events(records, 'spawn').length, 2);
  assert.equal(events(records, 'close').length, 2);
  assert.equal(events(records, 'configured').length, 0);
  assert.equal(calls(records, 'thread/start').length, 1);
  assert.equal(calls(records, 'turn/start').length, 0);
});

test('invalid final profile fails before even secret-free discovery is spawned', async t => {
  const { records } = await fixture(t, { invalidProfile: true });
  assert.equal(events(records, 'error')[0]?.code, 'MCP_PROFILE');
  assert.equal(events(records, 'spawn').length, 0);
});

test('embedded history loads the original project binding without selecting or starting/resuming a thread', async t => {
  const { records, dir, entry } = await fixture(t, { history: true });
  const helper = events(records, 'child')[2]!;
  assertSecretFree(helper);
  assert.equal(helper.cwd, await realpath(dir));
  assert.ok(!JSON.stringify(helper.args).includes(entry));
  assert.equal(events(records, 'history')[0]?.history?.completeness, 'complete');
  assert.equal(events(records, 'history')[0]?.history?.entries[0]?.ids.threadId, 'fixture-thread');
  assert.equal(events(records, 'history-after')[0]?.snapshot?.thread, null);
  assert.deepEqual(events(records, 'history-after')[0]?.snapshot, events(records, 'history-before')[0]?.snapshot);
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) assert.equal(calls(records, method).length, 0);
});

for (const [historyAction, expected] of [
  ['non-human', 'HUMAN_REQUIRED'], ['foreign-thread', 'THREAD'], ['foreign-session', 'THREAD'],
  ['invalid-id', 'ARGUMENTS'], ['extra-field', 'ARGUMENTS'], ['disconnected', 'DISCONNECTED'],
] as const) {
  test('embedded history ' + historyAction + ' keeps the original guard before helper spawn', async t => {
    const { records } = await fixture(t, { thread: true, history: true, historyAction });
    assert.equal(events(records, 'history-error')[0]?.code, expected);
    assert.equal(events(records, 'spawn').length, 2);
    assert.equal(calls(records, 'thread/read').length, 0);
    assert.equal(events(records, 'history').length, 0);
    assert.deepEqual(events(records, 'history-after')[0]?.snapshot, events(records, 'history-before')[0]?.snapshot);
    assert.equal(calls(records, 'thread/start').length, 1);
    assert.equal(calls(records, 'thread/resume').length, 0);
    assert.equal(calls(records, 'turn/start').length, 0);
  });
}

for (const historyResponse of ['wrong-thread', 'wrong-session', 'wrong-project'] as const) {
  test('embedded helper rejects changed ' + historyResponse + ' scope with the original projection checks', async t => {
    const { records } = await fixture(t, { thread: true, history: true, historyResponse });
    const history = events(records, 'history')[0]?.history;
    assert.equal(history?.completeness, 'rejected');
    assert.deepEqual(history?.entries, []);
    assert.deepEqual(history?.gaps.map(gap => gap.reason), ['scope-mismatch']);
    assertSecretFree(events(records, 'child')[2]!);
    assert.deepEqual(events(records, 'history-after')[0]?.snapshot, events(records, 'history-before')[0]?.snapshot);
    assert.equal(calls(records, 'thread/resume').length, 0);
    assert.equal(calls(records, 'turn/start').length, 0);
  });
}

for (const historyAction of ['close-pending', 'busy-pending'] as const) {
  test('embedded ' + historyAction + ' preserves cancellation/oneflight without extra helper or replay', async t => {
    const { records } = await fixture(t, { thread: true, history: true, historyAction });
    assert.equal(events(records, 'history-error')[0]?.code, 'STALE_CONNECTION');
    assert.equal(events(records, 'spawn').length, 3);
    assert.equal(events(records, 'history').length, 0);
    assert.equal(calls(records, 'thread/read').length, 1);
    assertSecretFree(events(records, 'child')[2]!);
    assert.equal(events(records, 'history-after')[0]?.snapshot?.ready, false);
    assert.equal(events(records, 'history-after')[0]?.snapshot?.thread?.threadId, 'fixture-thread');
    assert.equal(events(records, 'history-after')[0]?.snapshot?.thread?.configured, false);
    if (historyAction === 'busy-pending') assert.equal(events(records, 'busy-error')[0]?.code, 'BUSY');
    assert.equal(calls(records, 'thread/resume').length, 0);
    assert.equal(calls(records, 'turn/start').length, 0);
  });
}

test('each embedded history read receives fresh copies of the immutable secret-free template', async t => {
  const { records } = await fixture(t, { history: true, repeatHistory: true });
  const helpers = events(records, 'child').slice(2);
  assert.equal(helpers.length, 2);
  for (const helper of helpers) assertSecretFree(helper);
  assert.deepEqual(helpers[0]?.args, helpers[1]?.args);
  assert.ok(!JSON.stringify(helpers[1]?.args).includes('SYNTHETIC_BOUNDARY_MUTATION'));
  assert.equal(events(records, 'history').length, 2);
  for (const read of events(records, 'history')) assert.equal(read.history?.completeness, 'complete');
  assert.deepEqual(events(records, 'history-after')[0]?.snapshot, events(records, 'history-before')[0]?.snapshot);
  for (const method of ['thread/start', 'thread/resume', 'turn/start']) assert.equal(calls(records, method).length, 0);
});
