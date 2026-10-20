import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';

const native = { provider: 'codex' as const, threadId: 'exact-witness-thread', sessionId: null };
const denied = (suffix: string) => (error: unknown) => error instanceof ArcaneError && error.code === 'CONVERSATION_WORK_' + suffix;
function fixture(t: test.TestContext) {
  const boundary = realpathSync(tmpdir()), root = mkdtempSync(join(boundary, 'arcane-binding-witness-'));
  const parent = join(root, 'project-parent'), projectPath = join(parent, 'project'), directory = join(root, 'state');
  mkdirSync(projectPath, { recursive: true });
  const stores = new Set<ConversationWorkStore>();
  const open = () => { const store = new ConversationWorkStore({ projectPath, directory }); stores.add(store); return store; };
  const store = open();
  const binding = store.bind({ kind: 'asset-job', id: 'owned-job', conversation: native });
  t.after(() => {
    for (const current of stores) current.close();
    const part = relative(boundary, root);
    assert.ok(part.startsWith('arcane-binding-witness-') && !isAbsolute(part) && !part.includes('..') && !lstatSync(root).isSymbolicLink());
    rmSync(root, { recursive: true, force: true });
  });
  const change = (sql: string) => { const db = new DatabaseSync(join(directory, 'conversation-work.sqlite')); try { db.exec(sql); } finally { db.close(); } };
  return { root, parent, projectPath, directory, database: join(directory, 'conversation-work.sqlite'), store, binding, open, change };
}

test('capture returns an exact frozen host witness; unchanged checks perform only the SQLite change-counter query', t => {
  const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
  assert.deepEqual(witness.binding, f.binding); assert.ok(Object.isFrozen(witness));
  assert.ok(Object.isFrozen(witness.binding)); assert.ok(Object.isFrozen(witness.binding.conversation));
  assert.throws(() => { (witness.binding.conversation as { threadId: string }).threadId = 'another-thread'; }, TypeError);
  const queries: string[] = [], prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) { queries.push(sql); return Reflect.apply(prepare, this, [sql]); });
  witness.assertCurrent(); witness.assertCurrent(); witness.assertCurrent();
  assert.deepEqual(queries, ['PRAGMA data_version', 'PRAGMA data_version', 'PRAGMA data_version']);
  assert.equal(f.store.captureBinding('asset-job', 'missing'), null);
});

test('same-connection and other-connection unrelated appends refresh without changing the captured exact binding', t => {
  const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
  f.store.bind({ kind: 'asset-job', id: 'second-job', conversation: { ...native, sessionId: 'another-session' } });
  witness.assertCurrent();
  const second = f.open(); second.bind({ kind: 'workflow', id: 'third-workflow', conversation: native });
  witness.assertCurrent(); assert.deepEqual(witness.binding, f.binding);
  const queries: string[] = [], prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) { queries.push(sql); return Reflect.apply(prepare, this, [sql]); });
  witness.assertCurrent(); assert.deepEqual(queries, ['PRAGMA data_version']);
});

test('changed or removed exact binding never adopts another otherwise-valid stored conversation', t => {
  for (const sql of ["UPDATE conversation_work_bindings SET session_id='different-session' WHERE work_id='owned-job'", "DELETE FROM conversation_work_bindings WHERE work_id='owned-job'"]) {
    const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
    f.change(sql); assert.throws(() => witness.assertCurrent(), denied('CONFLICT'));
    assert.deepEqual(witness.binding, f.binding);
  }
});

test('external schema and unrelated row corruption force full validation and fail closed', t => {
  for (const [sql, code] of [["CREATE TABLE unexpected(payload TEXT) STRICT", 'CORRUPT'], ['PRAGMA user_version=3', 'MIGRATION'], ["INSERT INTO conversation_work_bindings VALUES(2,'asset-job','other','codex','invalid/path',NULL)", 'CORRUPT']] as const) {
    const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
    f.change(sql); assert.throws(() => witness.assertCurrent(), denied(code));
  }
});

test('changed file metadata refreshes full validation even without another SQLite commit', t => {
  const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
  const queries: string[] = [], prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) { queries.push(sql); return Reflect.apply(prepare, this, [sql]); });
  const saved = lstatSync(f.database); utimesSync(f.database, saved.atime, new Date(saved.mtimeMs + 60_000));
  witness.assertCurrent(); assert.ok(queries.some(sql => sql.includes('FROM sqlite_schema')));
  queries.length = 0; witness.assertCurrent(); assert.deepEqual(queries, ['PRAGMA data_version']);
});

test('a concurrent commit inside capture cannot become a new baseline after validation', t => {
  const f = fixture(t), prepare = DatabaseSync.prototype.prepare; let armed = true;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (sql === 'SELECT * FROM conversation_work_bindings WHERE kind=? AND work_id=?') {
      const get = statement.get;
      t.mock.method(statement, 'get', function (this: typeof statement, ...args: Parameters<typeof get>) {
        const row = Reflect.apply(get, this, args);
        if (armed) { armed = false; f.change("UPDATE conversation_work_bindings SET session_id='changed-during-capture' WHERE work_id='owned-job'"); }
        return row;
      });
    }
    return statement;
  });
  assert.throws(() => f.store.captureBinding('asset-job', 'owned-job'), denied('CHANGED'));
});

test('hard links to every existing fixed SQLite file and linked new sidecars are refused', t => {
  const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
  for (const suffix of ['', '-wal', '-shm']) {
    const source = f.database + suffix, alias = join(f.root, 'hardlink' + (suffix || '-main'));
    linkSync(source, alias);
    try { assert.throws(() => witness.assertCurrent(), denied('PATH')); } finally { unlinkSync(alias); }
    witness.assertCurrent();
  }
  const target = join(f.root, 'unrelated-journal'); writeFileSync(target, 'owned synthetic fixture');
  linkSync(target, f.database + '-journal');
  try { assert.throws(() => witness.assertCurrent(), denied('PATH')); } finally { unlinkSync(f.database + '-journal'); }
  witness.assertCurrent();
});

test('direct project replacement, project junction and linked ancestor all invalidate the original path witness', t => {
  for (const mode of ['replacement', 'project-link', 'ancestor-link']) {
    const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
    const source = mode === 'ancestor-link' ? f.parent : f.projectPath, moved = source + '-moved';
    renameSync(source, moved);
    if (mode === 'replacement') mkdirSync(source);
    else symlinkSync(moved, source, process.platform === 'win32' ? 'junction' : 'dir');
    try { assert.throws(() => witness.assertCurrent(), denied('PATH')); }
    finally { rmSync(source, { recursive: true, force: true }); renameSync(moved, source); }
    witness.assertCurrent();
  }
});

test('missing or replaced database cannot inherit an existing witness', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
  renameSync(f.database, f.database + '.original');
  assert.throws(() => witness.assertCurrent(), denied('PATH'));
  writeFileSync(f.database, 'owned replacement fixture');
  assert.throws(() => witness.assertCurrent(), denied('PATH'));
});

test('store close permanently fences an old witness, including after another store opens the same files', t => {
  const f = fixture(t), witness = f.store.captureBinding('asset-job', 'owned-job')!;
  f.store.close(); assert.throws(() => witness.assertCurrent(), denied('CLOSED'));
  const reopened = f.open(); assert.deepEqual(reopened.binding('asset-job', 'owned-job'), f.binding);
  assert.throws(() => witness.assertCurrent(), denied('CLOSED'));
  assert.throws(() => f.store.captureBinding('asset-job', 'owned-job'), denied('CLOSED'));
});
