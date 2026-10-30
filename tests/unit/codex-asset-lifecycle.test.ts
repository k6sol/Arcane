import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCodexClient } from '../../packages/codex-client/src/index.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import type { NativeAssetHooks, Operation, Snapshot } from '../../packages/codex-client/src/types.js';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';

const ROOT = resolve(process.cwd()), GENERIC = 'a4'.repeat(32), FINAL = 'c6'.repeat(32);
const EMITTED = fileURLToPath(new URL('../../packages/', import.meta.url));
const MODULES = [
  ...['index', 'mcp-profile', 'mcp-isolation', 'session', 'transport', 'types', 'validation', 'history', 'reference-images', 'rate-limits','proposal-result','tool-call','tool-failure'].map(name => 'codex-client/src/' + name + '.js'),
  ...['scenario-image', 'scenario-limits'].map(name => 'studio-test-controller/src/' + name + '.js'),
  'protocol/src/arcane-tools.js', // Imported by the unmodified production isolation module.
];
const hooks = (): NativeAssetHooks => Object.freeze({ finalCredential: () => FINAL, dispatched() {}, ended() {}, retired() {} });
type Scenario = { mode?: string; action?: string; hooks?: boolean; profile?: boolean; maxOperations?: number; credential?: string; mutateProfile?: boolean };
type Receipt = { event: string; launch?: number; args?: string[]; envKeys?: string[]; tokenHash?: string | null;
  audience?: string | null; daemonUrl?: string | null; method?: string; params?: Record<string, unknown>; code?: string;
  dispatched?: boolean; intent?: { connectionId: string; threadId: string; operationId: string }; frozen?: boolean;
  snapshot?: Snapshot; operation?: Operation; pending?: boolean; key?: string; };
const events = (rows: Receipt[], event: string) => rows.filter(row => row.event === event);
const calls = (rows: Receipt[], method: string) => rows.filter(row => row.event === 'rpc' && row.method === method);

// Reuse the discovery authority fixture's real factory/schema peer. Only synthetic
// responses and the Node process boundary change; product modules are copied verbatim.
const fixtureSource = await readFile(join(ROOT, 'tests', 'unit', 'codex-discovery-authority.test.ts'), 'utf8');
const basePeer = /const PEER = String\.raw`([\s\S]*?)\r?\n`;/u.exec(fixtureSource)?.[1];
assert.ok(basePeer, 'Existing discovery peer must remain available.');
const TURN_PEER = String.raw`
  if (!method && id === 'asset-tool') {
    record({ event: 'tool-reply' });
    return result(heldAck, { turn: { id: 'native.turn:asset-1', status: 'inProgress' } });
  }
  if (method === 'turn/start') {
    const turn = { id: 'native.turn:asset-' + (++turns), status: 'inProgress' };
    if (mode === 'reject') return reject(id);
    if (mode === 'unknown') return result(id, {});
    if (mode === 'lost-ack' || mode === 'close' || mode === 'revoke') return;
    if (mode === 'disconnect') return process.exit(0);
    if (mode === 'tool-before-ack') {
      heldAck = id;
      return send({ id: 'asset-tool', method: 'item/commandExecution/requestApproval',
        params: { threadId: 'fixture-thread', turnId: turn.id, itemId: 'asset-item', command: 'Synthetic tool window', cwd: process.cwd() } });
    }
    if (mode === 'terminal-before-ack') send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { ...turn, status: 'completed' } } });
    if (mode === 'terminal-ack' || mode === 'exhaustion' || mode === 'end-throw') turn.status = 'completed';
    if (mode === 'account-before-ack') send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
    result(id, { turn });
    if (mode === 'end-notification-throw') send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { ...turn, status: 'completed' } } });
    if (mode === 'account' || mode === 'account-chatgpt') send({ method: 'account/updated', params: { authMode: mode === 'account' ? 'apikey' : 'chatgpt' } });
    return;
  }
  if (method === 'turn/interrupt') return result(id, {});
`;
const PEER = basePeer
  .replace("const launch = scenario.launch, mode = scenario.mode;", "const launch = scenario.launch, mode = scenario.mode; let heldAck, turns = 0, checks = 0, accountReads = 0;")
  .replace("daemonUrl: process.env.ARCANE_DAEMON_URL || null", "audience: process.env.ARCANE_ASSET_AUDIENCE || null, daemonUrl: process.env.ARCANE_DAEMON_URL || null")
  .replace("  if (method === 'initialized') return;", TURN_PEER + "\n  if (method === 'initialized') return;")
  .replace("  if (method === 'account/read') return result", "  if (method === 'account/read' && ++accountReads > 1 && mode === 'account-read') return result(id, { account: { type: 'apiKey' }, requiresOpenaiAuth: false });\n  if (method === 'account/read') return result")
  .replace("    return result(id, { data, nextCursor: null });", "    if (params.threadId && ++checks > 1 && mode === 'preflight') data[1].runtimeStatus = 'connected';\n    return result(id, { data, nextCursor: null });");

const HARNESS = String.raw`
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const [root, audit, encoded] = process.argv.slice(2), scenario = JSON.parse(encoded);
const record = value => appendFileSync(audit, JSON.stringify(value) + '\n');
const rows = () => readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const until = async predicate => { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic evidence timed out'); await delay(5); } };
const library = pathToFileURL(join(root, 'packages', 'codex-client', 'src') + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && context.parentURL?.startsWith(library)) return { url: pathToFileURL(join(root, 'boundary.mjs')).href, shortCircuit: true };
  return next(specifier, context);
} });
process.env.ARCANE_LOCAL_TOKEN = 'b5'.repeat(32);
process.env.ARCANE_ASSET_AUDIENCE = 'AMBIENT_INVALID';
process.env.OPENAI_API_KEY = 'SYNTHETIC_PROVIDER_KEY';
process.env.CODEX_HOME = 'SYNTHETIC_PROVIDER_OVERRIDE';
const { connectCodexClient } = await import(library + 'index.js');
const { JsonlTransport } = await import(library + 'transport.js');
const { limits } = await import(library + 'validation.js');
const profile = { nodeExecutable: process.execPath, serverEntry: join(root, 'apps', 'mcp', 'src', 'main.js'),
  projectRoot: root, daemonUrl: 'http://127.0.0.1:47831', agentToken: 'a4'.repeat(32) };
let client;
const nativeAssetHooks = Object.freeze({
  finalCredential() {
    assert.ok(rows().some(row => row.event === 'close' && row.launch === 1), 'Discovery close precedes credential acquisition');
    record({ event: 'credential' });
    if (scenario.mutateProfile) { profile.daemonUrl = 'http://127.0.0.1:49999'; profile.serverEntry = join(root, 'foreign.js'); }
    if (scenario.credential === 'throw') throw new Error('SYNTHETIC_PRIVATE_CALLBACK_ERROR');
    return scenario.credential === 'reuse' ? 'a4'.repeat(32) : scenario.credential === 'invalid' ? 'invalid' : 'c6'.repeat(32);
  },
  dispatched(intent) {
    assert.ok(client.snapshot().operations.some(op => op.operationId === intent.operationId && op.requestId !== null && op.state === 'pending'));
    record({ event: 'dispatched', intent, frozen: Object.isFrozen(intent) });
    if (scenario.mode === 'hook-throw') throw new Error('SYNTHETIC_PRIVATE_CALLBACK_ERROR');
  },
  ended(intent) { record({ event: 'ended', intent }); if (scenario.mode === 'end-throw' || scenario.mode === 'end-notification-throw') throw new Error('SYNTHETIC_PRIVATE_CALLBACK_ERROR'); },
  retired() { record({ event: 'retired' }); if (scenario.mode === 'retire-throw') throw new Error('SYNTHETIC_PRIVATE_CALLBACK_ERROR'); }
});
const human = { initiatedBy: 'human' }, input = { ...human, threadId: 'fixture-thread', text: 'Synthetic native asset intent' };
try {
  if (scenario.action === 'transport') {
    const bounds = limits({ requestTimeoutMs: 5000 });
    const transport = new JsonlTransport({ command: join(root, process.platform === 'win32' ? 'codex.exe' : 'codex'), cwd: root, args: [], env: {} }, bounds, () => {}, error => record({ event: 'retired', code: error.code }));
    try {
      await transport.request('initialize', {}, undefined, () => record({ event: 'dispatched' }));
    } catch (error) { record({ event: 'error', code: error.code, dispatched: error.dispatched }); }
    try { await transport.request('turn/start', {}, () => { throw new Error('Synthetic pre-write error'); }, () => record({ event: 'dispatched' })); }
    catch (error) { record({ event: 'pre-write-error', code: error.code, dispatched: error.dispatched }); }
    await transport.close();
  } else {
    client = await connectCodexClient({ command: join(root, process.platform === 'win32' ? 'codex.exe' : 'codex'), cwd: root,
      use: 'personal-local', limits: { requestTimeoutMs: 5000, ...(scenario.maxOperations ? { maxOperations: scenario.maxOperations } : {}) },
      ...(scenario.profile !== false ? { arcaneMcp: profile } : {}), ...(scenario.hooks !== false ? { nativeAssetHooks } : {}) });
    record({ event: 'connected', snapshot: client.snapshot() });
    if (scenario.action === 'history') {
      await client.readThreadHistory({ ...human, threadId: 'fixture-thread', sessionId: 'fixture-session' });
      record({ event: 'history' });
    } else if (scenario.action !== 'connect') {
      client.selectModel({ ...human, model: 'fixture-model', effort: 'low' });
      await client.startThread(human);
      if (scenario.action === 'input') {
        for (const key of ['nativeAssetHooks', 'finalCredential', 'operationId', 'ARCANE_ASSET_AUDIENCE']) {
          try { await client.startTurn({ ...input, [key]: nativeAssetHooks }); } catch (error) { record({ event: 'input-error', key, code: error.code }); }
        }
        try { await client.startTurn({ ...input, initiatedBy: 'agent' }); } catch (error) { record({ event: 'input-error', code: error.code }); }
      } else {
        if (scenario.mode === 'revoke') client.grantThreadWrites({ ...human, threadId: input.threadId });
        const starting = client.startTurn(input).then(value => record({ event: 'ack', snapshot: client.snapshot() }), error => record({ event: 'error', code: error.code, dispatched: error.dispatched }));
        if (scenario.mode === 'tool-before-ack') {
          await until(() => client.snapshot().approvals.length === 1);
          const approval = client.snapshot().approvals[0], snapshot = client.snapshot();
          record({ event: 'tool-window', pending: snapshot.operations.at(-1).state === 'pending', snapshot });
          assert.equal(rows().filter(row => row.event === 'dispatched').length, 1);
          assert.equal(rows().filter(row => row.event === 'ended').length, 0);
          client.respondApproval({ ...human, handle: approval.handle, connectionId: approval.connectionId, threadId: approval.threadId, turnId: approval.turnId, decision: 'decline' });
        }
        if (scenario.mode === 'close' || scenario.mode === 'revoke') {
          await until(() => rows().some(row => row.event === 'rpc' && row.method === 'turn/start'));
          const closing = scenario.mode === 'close' ? client.close() : client.revokeThreadWrites({ ...human, threadId: input.threadId });
          record({ event: 'synchronous-fence', snapshot: client.snapshot() });
          assert.equal(rows().filter(row => row.event === 'retired').length, 1);
          await closing;
        }
        await starting;
        if (scenario.mode === 'interrupt') {
          const interrupting = client.interruptTurn({ ...human, threadId: input.threadId, turnId: client.snapshot().thread.turnId });
          assert.equal(rows().filter(row => row.event === 'ended').length, 1);
          record({ event: 'synchronous-fence', snapshot: client.snapshot() });
          await interrupting;
        }
        if (scenario.mode === 'account' || scenario.mode === 'account-chatgpt') await until(() => rows().some(row => row.event === 'retired'));
        // ACK and completion may arrive in separate pipe reads. Observe retirement
        // from the completion notification before finally.close() can cause it.
        if (scenario.mode === 'end-notification-throw') await until(() => rows().some(row => row.event === 'ended') && rows().some(row => row.event === 'retired'));
        if (scenario.mode === 'account-read') await client.readAccount();
        if (scenario.mode === 'exhaustion') { try { await client.startTurn(input); } catch (error) { record({ event: 'exhausted', code: error.code }); } }
        if (scenario.mode === 'lost-ack' || scenario.mode === 'unknown' || scenario.mode === 'hook-throw' || scenario.mode === 'end-throw' || scenario.mode === 'account-before-ack') {
          try { await client.startTurn(input); } catch (error) { record({ event: 'retry-fenced', code: error.code }); }
        }
      }
    }
    record({ event: 'before-close', snapshot: client.snapshot() });
  }
} catch (error) { record({ event: 'error', code: error.code, dispatched: error.dispatched }); }
finally { await client?.close(); }
`;

async function fixture(t: test.TestContext, scenario: Scenario = {}) {
  // The transport seam receives this path directly, before client validation.
  // Use the physical Windows spelling so an 8.3 TEMP alias cannot cause the
  // synthetic spawn boundary to throw before the METHOD assertion is reached.
  const dir = realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()), 'arcane-codex-assets-'))), audit = join(dir, 'audit.jsonl');
  t.after(async () => {
    const actual = await realpath(dir), parent = await realpath(tmpdir()), child = relative(parent, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-codex-assets-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  const entry = join(dir, 'apps', 'mcp', 'src', 'main.js');
  await mkdir(dirname(entry), { recursive: true });
  for (const name of MODULES) {
    const target = join(dir, 'packages', name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(EMITTED, name), target);
    assert.deepEqual(await readFile(target), await readFile(join(EMITTED, name)));
  }
  const command = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await writeFile(command, 'Synthetic validated path; never executed.'); await chmod(command, 0o700);
  await writeFile(entry, 'throw new Error("Synthetic MCP entry; never executed");');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'peer.cjs'), PEER);
  await writeFile(join(dir, 'harness.mjs'), HARNESS);
  const options = { mode: 'normal', ...scenario, arcaneToolNames: scenario.hooks === false ? ARCANE_TOOL_NAMES : ARCANE_NATIVE_TOOL_NAMES };
  const boundary = String.raw`
import { spawn as realSpawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(dir)}, audit = ${JSON.stringify(audit)}, scenario = ${JSON.stringify(options)};
const record = value => appendFileSync(audit, JSON.stringify(value) + '\n');
let launch = 0;
export function spawn(command, args, options) {
  if (command !== ${JSON.stringify(await realpath(command))}) throw new Error('Unexpected synthetic executable');
  const id = ++launch; record({ event: 'spawn', launch: id, args });
  const child = realSpawn(process.execPath, ['-e', readFileSync(join(root, 'peer.cjs'), 'utf8'), JSON.stringify({ ...scenario, launch: id }), audit, ...args], options);
  child.once('close', () => record({ event: 'close', launch: id }));
  if (scenario.mode === 'write-failure' && id === 2) {
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...rest) => { if (JSON.parse(String(data)).method === 'turn/start') throw new Error('Synthetic write failure'); return write(data, ...rest); };
  }
  return child;
}
`;
  await writeFile(join(dir, 'boundary.mjs'), boundary);
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [join(dir, 'harness.mjs'), dir, audit, JSON.stringify(options)], { cwd: dir, env: nativeEnvironment(), shell: false, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Synthetic asset harness timed out')); }, 15_000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', status => { clearTimeout(deadline); status === 0 ? accept() : reject(new Error(output || 'Synthetic harness failed')); });
  });
  const rows = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Receipt);
  for (const secret of [GENERIC, FINAL, 'b5'.repeat(32), 'SYNTHETIC_PRIVATE_CALLBACK_ERROR']) assert.ok(!JSON.stringify(rows).includes(secret));
  return rows;
}

test('hooks reject unfrozen, extra/symbol, inherited, missing and accessor callbacks without calling them', async () => {
  let reads = 0;
  const accessor = Object.freeze(Object.defineProperty({ ...hooks() }, 'dispatched', { get() { reads++; throw new Error('Accessor must not execute'); } }));
  for (const value of [{ ...hooks() }, Object.freeze({ ...hooks(), extra() {} }), Object.freeze({ ...hooks(), [Symbol('extra')]: () => {} }),
    Object.freeze(Object.create(hooks())), Object.freeze({ dispatched() {}, ended() {}, retired() {} }), accessor]) {
    await assert.rejects(connectCodexClient({ command: process.execPath, cwd: ROOT, use: 'personal-local', nativeAssetHooks: value } as never), { code: 'ARGUMENTS' });
  }
  assert.equal(reads, 0);
  await assert.rejects(connectCodexClient({ command: process.execPath, cwd: ROOT, use: 'personal-local', nativeAssetHooks: hooks() }), { code: 'MCP_PROFILE' });
  const accessorOption = Object.defineProperty({ command: process.execPath, cwd: ROOT, use: 'personal-local' }, 'nativeAssetHooks', { get() { reads++; return hooks(); } });
  await assert.rejects(connectCodexClient(accessorOption as never), { code: 'ARGUMENTS' }); assert.equal(reads, 0);
  assert.throws(() => new CodexSession({ command: process.execPath, cwd: ROOT, args: [], env: {} }, limits(), 'spawned-node-fixture', 'native-config', hooks()), { code: 'MCP_PROFILE' });
});

test('fresh final credential follows verified discovery close; exact final env/argv and secret-free helper survive profile mutation', async t => {
  const rows = await fixture(t, { action: 'history', mutateProfile: true });
  const children = events(rows, 'child'), final = children[1]!;
  assert.equal(events(rows, 'credential').length, 1);
  assert.ok(rows.indexOf(events(rows, 'close')[0]!) < rows.indexOf(events(rows, 'credential')[0]!));
  assert.equal(final.tokenHash, createHash('sha256').update(FINAL).digest('hex'));
  assert.equal(final.daemonUrl, 'http://127.0.0.1:47831'); assert.equal(final.audience, 'native-session');
  assert.equal(final.args?.filter(arg => arg.startsWith('mcp_servers.arcane.env_vars=')).length, 1);
  assert.ok(final.args?.includes('mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN","ARCANE_ASSET_AUDIENCE"]'));
  assert.deepEqual(final.args?.filter(arg => arg.startsWith('mcp_servers.arcane.enabled_tools=')),
    ['mcp_servers.arcane.enabled_tools=' + JSON.stringify(ARCANE_NATIVE_TOOL_NAMES)]);
  for (const child of [children[0]!, children[2]!]) {
    assert.equal(child.tokenHash, null); assert.equal(child.daemonUrl, null); assert.equal(child.audience, null);
    assert.ok(!child.envKeys?.some(key => key.toLowerCase().startsWith('arcane_')));
    assert.ok(!JSON.stringify(child.args).includes('ARCANE_ASSET_AUDIENCE'));
  }
  assert.equal(events(rows, 'dispatched').length, 0); assert.equal(events(rows, 'retired').length, 1);
});

for (const mode of ['arcane-active', 'arcane-plugin', 'arcane-metadata', 'inventory-failure', 'unsafe-key', 'discovery-init-failure']) {
  test('discovery ' + mode + ' acquires no credential or final authority', async t => {
    const rows = await fixture(t, { mode, action: 'connect' });
    assert.equal(events(rows, 'credential').length, 0); assert.equal(events(rows, 'spawn').length, 1);
    assert.equal(events(rows, 'retired').length, 1);
  });
}
for (const credential of ['invalid', 'reuse', 'throw']) test('final credential ' + credential + ' fails closed without final spawn', async t => {
  const rows = await fixture(t, { credential, action: 'connect' });
  assert.equal(events(rows, 'credential').length, 1); assert.equal(events(rows, 'spawn').length, 1); assert.equal(events(rows, 'retired').length, 1);
});

test('local intent opens after write, before pre-ACK tool window, with real native operation and connection IDs', async t => {
  const rows = await fixture(t, { mode: 'tool-before-ack' }), opened = events(rows, 'dispatched')[0]!, window = events(rows, 'tool-window')[0]!;
  assert.equal(opened.frozen, true); assert.equal(window.pending, true);
  const operation = window.snapshot!.operations.at(-1)!;
  assert.deepEqual(opened.intent, { connectionId: window.snapshot!.connectionId, threadId: 'fixture-thread', operationId: operation.operationId });
  assert.equal(operation.method, 'turn/start'); assert.equal(operation.turnId, 'native.turn:asset-1');
  assert.ok(rows.indexOf(opened) < rows.indexOf(window));
  assert.deepEqual(events(rows, 'ended')[0]?.intent, opened.intent);
  assert.equal(calls(rows, 'turn/start').length, 1); assert.equal(events(rows, 'dispatched').length, 1);
  const params = calls(rows, 'turn/start')[0]!.params!;
  assert.deepEqual(Object.keys(params).sort(), ['approvalPolicy','approvalsReviewer','cwd','effort','input','model','sandboxPolicy','threadId'].sort());
  for (const key of ['nativeAssetHooks', 'finalCredential', 'operationId', 'ARCANE_ASSET_AUDIENCE']) assert.ok(!Object.hasOwn(window.snapshot!, key));
});

for (const mode of ['terminal-before-ack', 'terminal-ack', 'interrupt']) test(mode + ' ends the dispatched intent once and late ACK never opens it again', async t => {
  const rows = await fixture(t, { mode });
  assert.equal(events(rows, 'dispatched').length, 1); assert.equal(events(rows, 'ended').length, 1);
  assert.deepEqual(events(rows, 'ended')[0]?.intent, events(rows, 'dispatched')[0]?.intent);
  const before = events(rows, 'before-close')[0]!.snapshot!;
  if (mode !== 'interrupt') { assert.equal(before.thread?.turnStatus, 'completed'); assert.ok(rows.indexOf(events(rows, 'ended')[0]!) < rows.indexOf(events(rows, 'ack')[0]!)); }
  else assert.equal(events(rows, 'synchronous-fence')[0]?.snapshot?.thread?.turnStatus, 'cancelling');
  assert.equal(before.operations.find(op => op.method === 'turn/start')?.state, 'acknowledged');
});

for (const [mode, code, state, dispatched] of [
  ['write-failure', 'IO', 'not-sent', false], ['preflight', 'MCP_ISOLATION', undefined, false],
  ['reject', 'REMOTE_REJECTED', 'rejected', true], ['unknown', 'PROTOCOL', 'unknown', true],
  ['hook-throw', 'UNKNOWN', 'unknown', true], ['end-throw', 'UNKNOWN', 'unknown', true], ['lost-ack', 'TIMEOUT', 'unknown', true],
] as const) test(mode + ' keeps dispatch certainty and never replays', async t => {
  const rows = await fixture(t, { mode }), error = events(rows, 'error')[0]!;
  assert.equal(error.code, code); assert.equal(error.dispatched, dispatched);
  const before = events(rows, 'before-close')[0]!.snapshot!;
  assert.equal(before.operations.find(op => op.method === 'turn/start')?.state, state);
  if (state === 'unknown') assert.ok(rows.indexOf(events(rows, 'retired')[0]!) < rows.indexOf(error));
  assert.equal(events(rows, 'dispatched').length, dispatched ? 1 : 0);
  if (['preflight', 'unknown', 'hook-throw', 'lost-ack'].includes(mode)) assert.equal(before.ready, false);
  if (mode !== 'hook-throw') assert.equal(calls(rows, 'turn/start').length, mode === 'preflight' || mode === 'write-failure' ? 0 : 1);
  assert.ok(calls(rows, 'turn/start').length <= 1); assert.equal(events(rows, 'retired').length, 1);
});
test('an ended exception after a queued ACK retires without restoring native authority', async t => {
  const rows = await fixture(t, { mode: 'end-notification-throw' });
  assert.equal(events(rows, 'ended').length, 1); assert.equal(events(rows, 'retired').length, 1);
  assert.equal(events(rows, 'before-close')[0]?.snapshot?.ready, false);
  // Both frame delivery groupings are valid: ACK already acknowledged, or fenced while queued.
  assert.ok(['acknowledged', 'unknown'].includes(events(rows, 'before-close')[0]!.snapshot!.operations.at(-1)!.state));
});

for (const mode of ['close', 'revoke', 'disconnect', 'account', 'account-chatgpt', 'account-before-ack', 'account-read', 'retire-throw']) test(mode + ' retires authority once and synchronously fences the current intent', async t => {
  const rows = await fixture(t, { mode });
  assert.equal(events(rows, 'dispatched').length, 1); assert.equal(events(rows, 'ended').length, 1); assert.equal(events(rows, 'retired').length, 1);
  assert.ok(rows.indexOf(events(rows, 'ended')[0]!) < rows.indexOf(events(rows, 'retired')[0]!));
  if (mode !== 'retire-throw') assert.equal(events(rows, 'before-close')[0]?.snapshot?.ready, false);
});

test('bounded native operation history retires without erasing operations or opening another intent', async t => {
  const rows = await fixture(t, { mode: 'exhaustion', maxOperations: 2 });
  assert.equal(events(rows, 'exhausted')[0]?.code, 'OPERATION_LIMIT');
  assert.equal(events(rows, 'before-close')[0]?.snapshot?.operations.length, 2);
  assert.equal(events(rows, 'before-close')[0]?.snapshot?.ready, false);
  assert.equal(events(rows, 'dispatched').length, 1); assert.equal(calls(rows, 'turn/start').length, 1);
});
test('hooks and lifecycle IDs remain outside human input and the transport seam is restricted to turn/start', async t => {
  const rows = await fixture(t, { action: 'input' });
  assert.equal(events(rows, 'input-error').length, 5); assert.equal(calls(rows, 'turn/start').length, 0);
  const transport = await fixture(t, { action: 'transport' });
  assert.equal(events(transport, 'error')[0]?.code, 'METHOD');
  assert.equal(events(transport, 'pre-write-error')[0]?.dispatched, false);
  assert.equal(events(transport, 'dispatched').length, 0); assert.equal(calls(transport, 'turn/start').length, 0);
});
for (const profile of [false, true]) test('no-hooks compatibility preserves ' + (profile ? 'generic Arcane' : 'native-config') + ' launch', async t => {
  const rows = await fixture(t, { action: 'connect', hooks: false, profile });
  assert.equal(events(rows, 'credential').length, 0); assert.equal(events(rows, 'retired').length, 0);
  assert.equal(events(rows, 'dispatched').length, 0);
  const children = events(rows, 'child'); assert.equal(children.length, profile ? 2 : 1);
  const final = children.at(-1)!; assert.equal(final.audience, null);
  if (profile) assert.deepEqual(final.args?.filter(arg => arg.startsWith('mcp_servers.arcane.enabled_tools=')),
    ['mcp_servers.arcane.enabled_tools=' + JSON.stringify(ARCANE_TOOL_NAMES)]);
  assert.equal(final.tokenHash, profile ? createHash('sha256').update(GENERIC).digest('hex') : null);
  assert.ok(!JSON.stringify(final.args).includes('ARCANE_ASSET_AUDIENCE'));
});
test('final initialization failure retires the acquired authority once', async t => {
  const rows = await fixture(t, { action: 'connect', mode: 'final-init-failure' });
  assert.equal(events(rows, 'credential').length, 1); assert.equal(events(rows, 'spawn').length, 2);
  assert.equal(events(rows, 'retired').length, 1); assert.equal(events(rows, 'dispatched').length, 0);
});
