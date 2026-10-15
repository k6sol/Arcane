import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { STARTUP_FAILURE_CODES, classifyStartupFailure, reportStartupFailure, startupFailureMessage, type StartupFailureMessage } from '../../apps/daemon/src/startup-failure.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';

// Standalone fixtures: an owned loopback listener and disposable SQLite files.
// No daemon, desktop, provider or Studio process is started.
async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'arcane-startup-failure-'));
  t.after(async () => {
    // Recursive cleanup only for the exact owned direct child of the resolved OS temp root.
    const base = await realpath(tmpdir()), actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-startup-failure-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  return root;
}
function caught(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  assert.fail('Expected a refusal.');
}
const listen = (server: Server, port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });

test('only a genuine listener bind conflict is classified as a port conflict', async t => {
  const owner = createServer(); await listen(owner, 0); t.after(() => new Promise<void>(resolve => owner.close(() => resolve())));
  const address = owner.address(); assert.ok(address && typeof address === 'object');
  const second = createServer();
  const error = await listen(second, address.port).then(() => assert.fail('The occupied port must refuse a second bind.'), (error: unknown) => error);
  assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
  assert.equal(classifyStartupFailure('listen', error), 'PORT_IN_USE');
  // The same OS error outside the listener phase, or a look-alike without the listen syscall, is not proof.
  assert.equal(classifyStartupFailure('services', error), 'STARTUP_FAILED');
  assert.equal(classifyStartupFailure('listen', Object.assign(new Error('fabricated'), { code: 'EADDRINUSE' })), 'STARTUP_FAILED');
  assert.equal(classifyStartupFailure('listen', { code: 'EACCES', syscall: 'listen' }), 'STARTUP_FAILED');
});

test('real newer-schema store refusals give version guidance', async t => {
  const root = await scratch(t);
  const studio = join(root, 'studio'), work = join(root, 'work');
  for (const [directory, file, version] of [[studio, 'studio.sqlite', 7], [work, 'work.sqlite', 2]] as const) {
    await import('node:fs/promises').then(fs => fs.mkdir(directory, { recursive: true }));
    const db = new DatabaseSync(join(directory, file)); db.exec('PRAGMA user_version=' + version); db.close();
  }
  const studioError = caught(() => new StudioStore({ directory: studio }));
  assert.match(String((studioError as Error).message), /newer than this Arcane build/);
  assert.equal(classifyStartupFailure('services', studioError), 'STATE_NEWER');
  const workError = caught(() => new WorkStore({ directory: work, projectPath: root }));
  assert.match(String((workError as Error).message), /newer than this build/);
  assert.equal(classifyStartupFailure('services', workError), 'STATE_NEWER');
});

test('fixed store refusal texts for later schemas are recognized', () => {
  for (const message of ['Workflow database is newer than this build.', 'Conversation work schema is newer than this build.',
    'Learning database is newer than this build; refusing to overwrite.', 'Native journal is newer than this build.', 'Task journal is newer than this build.']) {
    assert.equal(classifyStartupFailure('services', new Error(message)), 'STATE_NEWER', message);
  }
  assert.equal(classifyStartupFailure('services', new Error('Learning schema changed; close and inspect the database.')), 'STARTUP_FAILED');
});

test('phase determines state, resource and generic codes', () => {
  assert.equal(classifyStartupFailure('state', new Error('Arcane runtime state exceeds the validation entry limit.')), 'STATE_UNSAFE');
  assert.equal(classifyStartupFailure('state', new Error('ARCANE_STATE_DIRECTORY cannot contain links or redirected directories.')), 'STATE_UNSAFE');
  assert.equal(classifyStartupFailure('resources', new Error('Arcane resource installation is unavailable.')), 'RESOURCE_UNAVAILABLE');
  for (const phase of ['services', 'descriptor', 'listen'] as const) assert.equal(classifyStartupFailure(phase, new Error('unexpected')), 'STARTUP_FAILED');
  for (const value of [undefined, null, 'text', 7]) assert.equal(classifyStartupFailure('services', value), 'STARTUP_FAILED');
});

test('the IPC message carries only the fixed code', () => {
  for (const code of STARTUP_FAILURE_CODES) assert.deepEqual(startupFailureMessage(code), { type: 'arcane-startup-failure', protocolVersion: 1, code });
  assert.throws(() => startupFailureMessage('C:\\Users\\secret' as never), /Unknown startup failure code/);
});

test('report sends one message to a connected parent and keeps paths and error text private', async () => {
  const sent: StartupFailureMessage[] = [];
  const error = Object.assign(new Error('C:\\Users\\private\\state token=abc'), { code: 'MIGRATION' });
  const code = await reportStartupFailure('state', error, { connected: true, send(message, callback) { sent.push(message); callback(null); return true; } });
  assert.equal(code, 'STATE_UNSAFE');
  assert.deepEqual(sent, [{ type: 'arcane-startup-failure', protocolVersion: 1, code: 'STATE_UNSAFE' }]);
  assert.equal(JSON.stringify(sent).includes('private'), false);
});

test('report is bounded and never throws without a usable parent', async () => {
  let calls = 0;
  assert.equal(await reportStartupFailure('services', new Error('x'), { connected: false, send() { calls++; return true; } }), 'STARTUP_FAILED');
  assert.equal(await reportStartupFailure('services', new Error('x'), {}), 'STARTUP_FAILED');
  assert.equal(await reportStartupFailure('services', new Error('x'), { connected: true, send() { calls++; throw new Error('channel closed'); } }), 'STARTUP_FAILED');
  const started = Date.now();
  assert.equal(await reportStartupFailure('services', new Error('x'), { connected: true, send() { calls++; return true; } }, 50), 'STARTUP_FAILED');
  assert.ok(Date.now() - started < 2000, 'A missing send acknowledgement must not hold startup failure open.');
  assert.equal(calls, 2);
});

test('an unacknowledged report cannot end the process on an unsettled top-level await', () => {
  // Isolated Node fixture with no other live handles: the original error must still be rethrown.
  const module = new URL('../../apps/daemon/src/startup-failure.js', import.meta.url).href;
  const script = 'const { reportStartupFailure } = await import(' + JSON.stringify(module) + ');\n' +
    "await reportStartupFailure('state', new Error('private detail'), { connected: true, send() { return true; } }, 200);\n" +
    "throw new Error('ORIGINAL_STARTUP_FAILURE');";
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '' } });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1, 'Exit 13 would mean the unsettled await ended the process first: ' + run.stderr);
  assert.match(run.stderr, /ORIGINAL_STARTUP_FAILURE/);
  assert.doesNotMatch(run.stderr, /unsettled top-level await/i);
});
