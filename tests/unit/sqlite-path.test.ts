import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { READ_METHODS } from '../../packages/protocol/src/studio.js';
import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';

const SOURCE = resolve(process.cwd());
const EMITTED = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const policy = require(join(SOURCE, 'apps/desktop/electron/policy.cjs')) as {
  daemonEnvironment(source: NodeJS.ProcessEnv, paths: { productRoot: string; stateRoot: string; projectPath: string }): NodeJS.ProcessEnv;
  readyMessage(message: unknown): { origin: string; token: string };
};
const { runBoundedChild } = await import(pathToFileURL(join(SOURCE, 'scripts/check-windows-executable.mjs')).href) as {
  runBoundedChild(command: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; ipc: true; deadlineMs: number; maxOutputBytes: number;
    onMessage(message: unknown, child: ChildProcess): void;
  }): Promise<{ code: number | null; signal: string | null; output: string }>;
};
function owned(t: TestContext, cleanup = () => true): string {
  const root = makeFixtureDirectory('arcane-sqlite-transport-');
  t.after(() => {
    if (!cleanup()) { t.diagnostic('Retained isolated fixture files for inspection: ' + root); return; }
    const boundary = fixtureTempDirectory(), physical = realpathSync.native(root), part = relative(boundary, physical);
    assert.ok(part.startsWith('arcane-sqlite-transport-') && !isAbsolute(part) && !part.includes(sep));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(physical, { recursive: true, force: true });
  });
  return root;
}
function deep(root: string): string {
  let directory = root;
  for (let index = 0; directory.length < 310 && index < 8; index++) directory = join(directory, 'owned-' + index + '-' + 'x'.repeat(40));
  assert.ok(directory.length >= 310 && directory.length < 512);
  mkdirSync(directory, { recursive: true });
  return directory;
}
function open(filename: string): DatabaseSync {
  return new DatabaseSync(sqliteTransportPath(filename), { timeout: 2000, allowExtension: false });
}

test('SQLite special filenames retain temporary and in-memory database behavior', () => {
  for (const filename of ['', ':memory:']) {
    assert.equal(sqliteTransportPath(filename), filename);
    const database = open(filename);
    try {
      database.exec('CREATE TABLE sample(value INTEGER NOT NULL) STRICT; BEGIN IMMEDIATE; INSERT INTO sample VALUES(42); COMMIT;');
      assert.equal(database.prepare('SELECT value FROM sample').get()!.value, 42);
      assert.equal(database.prepare('PRAGMA database_list').get()!.file, '');
    } finally { database.close(); }
  }
  const unchanged = process.platform === 'win32'
    ? ['\\\\?\\C:\\owned\\sample.sqlite', '\\\\?\\UNC\\server\\share\\sample.sqlite', '\\\\.\\pipe\\sample']
    : ['/owned/sample.sqlite', 'relative.sqlite', 'C:\\owned\\sample.sqlite'];
  for (const filename of unchanged) assert.equal(sqliteTransportPath(filename), filename);
});

test('Windows deep SQLite filename supports WAL transactions, rollback and durable reopen at the canonical file', {
  skip: process.platform !== 'win32',
}, t => {
  const filename = join(deep(owned(t)), 'persistent.sqlite');
  assert.ok(filename.length > 306);
  let database = open(filename);
  try {
    assert.equal(database.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode, 'wal');
    database.exec('PRAGMA synchronous=FULL; CREATE TABLE sample(value INTEGER PRIMARY KEY) STRICT; BEGIN IMMEDIATE; INSERT INTO sample VALUES(42); COMMIT;');
    assert.throws(() => database.exec('BEGIN IMMEDIATE; INSERT INTO sample VALUES(43); INSERT INTO sample VALUES(42); COMMIT;'));
    database.exec('ROLLBACK;');
    assert.deepEqual(database.prepare('SELECT value FROM sample').all().map(row => row.value), [42]);
    const stat = lstatSync(filename);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
    assert.equal(lstatSync(filename + '-wal').isFile(), true);
  } finally { database.close(); }
  database = open(filename);
  try {
    assert.equal(database.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(database.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.deepEqual(database.prepare('SELECT value FROM sample').all().map(row => row.value), [42]);
  } finally { database.close(); }
});

test('Windows deep production stores retain canonical identity and metadata across close and reopen', {
  skip: process.platform !== 'win32',
}, t => {
  const root = owned(t), directory = deep(root), project = join(root, 'project');
  mkdirSync(project);
  const studioDirectory = join(directory, 'studio');
  let studio = new StudioStore({ directory: studioDirectory });
  let sessionId: string | undefined;
  try {
    const grant = studio.createGrant({ allowedRoots: ['Workspace'], allowWrites: false });
    sessionId = studio.pair({ code: grant.code, protocolVersion: 1,
      identity: { clientSessionId: 'offline-deep-path-lifetime', placeId: 0, universeId: 0, name: 'Offline deep path fixture', pluginVersion: 'fixture' },
      capabilities: [...READ_METHODS] }).sessionId;
  } finally { studio.close(); }
  assert.ok(sessionId);
  studio = new StudioStore({ directory: studioDirectory });
  try { assert.equal(studio.session(sessionId, false).clientSessionId, 'offline-deep-path-lifetime'); }
  finally { studio.close(); }
  const options = { directory: join(directory, 'associations'), projectPath: project };
  const conversation = { provider: 'codex' as const, threadId: 'offline.deep-path', sessionId: null };
  let associations = new ConversationWorkStore(options);
  const identity = associations.projectId;
  try { associations.bind({ conversation, kind: 'workflow', id: 'offline-workflow' }); }
  finally { associations.close(); }
  associations = new ConversationWorkStore(options);
  try {
    assert.equal(associations.projectPath, realpathSync(project));
    assert.equal(associations.projectId, identity);
    assert.equal(associations.list(conversation).items[0]?.id, 'offline-workflow');
    assert.equal(associations.projectPath.startsWith('\\\\?\\'), false);
  } finally { associations.close(); }
});

test('Windows actual daemon opens and closes all seven deep stores through isolated metadata reads without native work', {
  skip: process.platform !== 'win32', timeout: 60_000,
}, async t => {
  let terminal = false;
  let passed = false;
  const root = owned(t, () => terminal && passed);
  // Match the real host: cwd remains below CreateProcess's legacy directory
  // bound while the unchanged SHA-scoped state layout makes SQLite paths deep.
  const profile = join(root, 'profile-' + 'x'.repeat(Math.max(1, 220 - root.length - 9)));
  assert.equal(profile.length, 220);
  const project = join(profile, 'projects', 'Untitled');
  // Receipt guards deliberately reject mutable TEMP ancestors. Give the child
  // one fresh short home under the real canonical home, retaining its ordinary
  // trusted ancestors without reading or changing existing account/session data.
  const homeBoundary = realpathSync.native(homedir());
  const home = realpathSync.native(mkdtempSync(join(homeBoundary, 'arcane-sqlite-home-')));
  t.after(() => {
    if (!terminal || !passed) { t.diagnostic('Retained isolated home for inspection: ' + home); return; }
    const physical = realpathSync.native(home), part = relative(homeBoundary, physical);
    assert.ok(part.startsWith('arcane-sqlite-home-') && !isAbsolute(part) && !part.includes(sep));
    assert.equal(lstatSync(home).isSymbolicLink(), false);
    rmSync(physical, { recursive: true, force: true });
  });
  const temp = join(root, 'temp');
  const appData = join(home, 'AppData', 'Roaming'), localAppData = join(home, 'AppData', 'Local');
  for (const directory of [project, home, temp, appData, localAppData]) mkdirSync(directory, { recursive: true });
  const key = createHash('sha256').update(project.toLowerCase()).digest('hex');
  const state = join(profile, 'runtime', 'projects', key);
  mkdirSync(state, { recursive: true });
  const env = policy.daemonEnvironment({ ...process.env, USERPROFILE: home, HOME: home, APPDATA: appData,
    LOCALAPPDATA: localAppData, TEMP: temp, TMP: temp }, { productRoot: SOURCE, stateRoot: state, projectPath: project });
  let ready = false, token = '', check: Promise<void> | undefined, observationError: unknown;
  const result = await runBoundedChild(process.execPath, [join(EMITTED, 'apps/daemon/src/product-main.js')], {
    cwd: profile, env, ipc: true, deadlineMs: 30_000, maxOutputBytes: 65_536,
    onMessage(message, child) {
      const handoff = policy.readyMessage(message);
      assert.equal(ready, false); ready = true; token = handoff.token;
      check = (async () => {
        const headers = { Authorization: 'Bearer ' + token };
        const response = await fetch(handoff.origin + '/v1/product/state', { headers, signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 200);
        const product = await response.json() as { studioSessions: unknown[]; commandCounts: Record<string, number> };
        assert.deepEqual(product.studioSessions, []);
        assert.ok(Object.values(product.commandCounts).every(count => count === 0));
        const native = await fetch(handoff.origin + '/v1/codex/state', { headers, signal: AbortSignal.timeout(5_000) });
        assert.equal(native.status, 200);
        const codex = await native.json() as { state: { snapshot: unknown; actions: unknown[] } };
        assert.equal(codex.state.snapshot, null); assert.deepEqual(codex.state.actions, []);
        // These stores are deliberately lazy. Read their real metadata routes
        // before claiming the full database inventory, including the existing
        // private receipt-storage preflight confined to this isolated home.
        const learning = await fetch(handoff.origin + '/v1/learning/state', { headers, signal: AbortSignal.timeout(15_000) });
        const learningBody = await learning.text();
        assert.equal(learning.status, 200, learningBody.slice(0, 4096));
        const memory = JSON.parse(learningBody) as { settings: { optIn: boolean }; records: unknown[] };
        assert.equal(memory.settings.optIn, false); assert.deepEqual(memory.records, []);
        const workflow = await fetch(handoff.origin + '/v1/workflows', { headers, signal: AbortSignal.timeout(15_000) });
        const workflowBody = await workflow.text();
        assert.equal(workflow.status, 200, workflowBody.slice(0, 4096));
        assert.deepEqual((JSON.parse(workflowBody) as { workflows: unknown[] }).workflows, []);
      })().catch(error => { observationError = error; }).finally(() => { if (child.connected) child.disconnect(); });
    },
  });
  terminal = true;
  await check;
  const output = result.output.replaceAll(token || 'not-a-private-token', '[REDACTED]')
    .replace(/#[a-f0-9]{64}\b/gi, '#[REDACTED]').slice(0, 8_192);
  assert.equal(result.code, 0, output); assert.equal(result.signal, null);
  assert.equal(ready, true, output); if (observationError) throw observationError;
  assert.equal(existsSync(join(state, 'studio.lock')), false);
  assert.equal(existsSync(join(state, 'daemon.json')), false);
  const filenames = ['studio.sqlite', 'work.sqlite', 'learning/learning.sqlite',
    'connection-lab/conversation-work/conversation-work.sqlite', 'connection-lab/native-codex/codex-actions.sqlite',
    'connection-lab/native-codex/chat-tasks/chat-tasks.sqlite',
    'connection-lab/workflows/workflow.sqlite'];
  for (const filename of filenames) {
    const canonical = join(state, filename);
    assert.ok(canonical.length > 306);
    const stat = lstatSync(canonical);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
    const database = open(canonical);
    try {
      assert.equal(database.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal', filename);
      assert.equal(database.prepare('PRAGMA quick_check').get()!.quick_check, 'ok', filename);
      if (filename.includes('conversation-work')) assert.equal(database.prepare('SELECT project_path FROM conversation_work_meta').get()!.project_path, project);
      if (filename.endsWith('workflow.sqlite')) assert.equal(database.prepare('SELECT project_path FROM workflow_meta').get()!.project_path, project);
    } finally { database.close(); }
  }
  passed = true;
});
