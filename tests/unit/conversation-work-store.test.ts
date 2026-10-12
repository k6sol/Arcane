import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { CONVERSATION_WORK_LIMITS, ConversationWorkStore, type ConversationWorkBinding, type ConversationWorkKind, type ConversationWorkPagination, type NativeConversation } from '../../packages/storage/src/conversation-work-store.js';

const native: NativeConversation = { provider: 'codex', threadId: 'Thread:Exact.1', sessionId: null };
const code = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === 'CONVERSATION_WORK_' + expected;
const projectHash = (path: string) => createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-conversation-work-'));
  const project = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(project);
  const stores = new Set<ConversationWorkStore>();
  function open(options = { directory, projectPath: project }) {
    const value = new ConversationWorkStore(options); stores.add(value); return value;
  }
  let store = open();
  t.after(() => {
    for (const value of stores) value.close();
    const physical = realpathSync(root), boundary = realpathSync(tmpdir());
    assert.ok(physical.startsWith(boundary + sep) && !lstatSync(root).isSymbolicLink());
    rmSync(physical, { recursive: true, force: true });
  });
  return { root, project, directory, database: join(directory, 'conversation-work.sqlite'), open,
    get store() { return store; }, reopen() { store.close(); store = open(); return store; } };
}
type Fixture = ReturnType<typeof fixture>;
function database(f: Fixture, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(f.database);
  try { work(db); } finally { db.close(); }
}
function bind(f: Fixture, id = 'work-1', conversation = native, kind: ConversationWorkKind = 'workflow') {
  return f.store.bind({ conversation, kind, id });
}
function invalidBind(store: ConversationWorkStore, input: unknown): void {
  store.bind(input as Parameters<ConversationWorkStore['bind']>[0]);
}

// Synthetic native metadata only: no provider history, model or Studio fixture is used.
test('canonical project hash/path and exact bindings survive restart without backfill', t => {
  const f = fixture(t);
  assert.equal(f.store.projectPath, realpathSync(f.project));
  assert.equal(f.store.projectId, projectHash(realpathSync(f.project)));
  assert.deepEqual(f.store.list(native), { items: [], nextCursor: null });
  assert.equal(f.store.binding('workflow', 'old-draft'), null);
  const original = bind(f);
  const expected: ConversationWorkBinding = { projectId: f.store.projectId, conversation: native, kind: 'workflow', id: 'work-1' };
  assert.deepEqual(original, expected);
  f.reopen();
  assert.deepEqual(f.store.binding('workflow', 'work-1'), expected);
  assert.deepEqual(bind(f), expected);
  assert.equal(f.store.binding('workflow', 'old-draft'), null);
  assert.deepEqual(f.store.list(native).items, [expected]);
  database(f, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_work_bindings').get()?.n, 1);
  });
});

test('provider, thread, session, case and namespace are all exact independent keys', t => {
  const f = fixture(t);
  const conversations: NativeConversation[] = [native,
    { ...native, provider: 'claude-code' }, { ...native, threadId: 'Other-thread' },
    { ...native, sessionId: 'Session-A' }, { ...native, sessionId: 'session-a' },
    { ...native, threadId: native.threadId.toLowerCase() }];
  conversations.forEach((value, i) => bind(f, 'work-' + i, value));
  bind(f, 'work-0', conversations[1]!, 'asset-job');
  for (const [i, value] of conversations.entries()) {
    assert.deepEqual(f.store.list(value, 'workflow').items.map(item => item.id), ['work-' + i]);
  }
  assert.equal(f.store.binding('workflow', 'work-0')?.conversation.provider, 'codex');
  assert.equal(f.store.binding('asset-job', 'work-0')?.conversation.provider, 'claude-code');
  assert.equal(f.store.binding('workflow', 'WORK-0'), null);
  assert.equal(f.store.list({ ...native, sessionId: 'unobserved' }).items.length, 0);
});

test('identical replay is detached; changed native identity conflicts and cannot overwrite', t => {
  const f = fixture(t);
  const original = bind(f);
  original.conversation.threadId = 'caller-mutated'; original.id = 'caller-mutated'; original.projectId = 'caller-mutated';
  const replay = bind(f);
  assert.equal(replay.conversation.threadId, native.threadId);
  const page = f.store.list(native); page.items[0]!.conversation.provider = 'claude-code';
  assert.equal(f.store.binding('workflow', 'work-1')?.conversation.provider, 'codex');
  for (const changed of [{ ...native, provider: 'claude-code' as const }, { ...native, threadId: 'Different' }, { ...native, sessionId: 'Session-1' }]) {
    assert.throws(() => bind(f, 'work-1', changed), code('CONFLICT'));
    assert.equal(f.store.list(changed).items.length, 0);
  }
  const withSession = { ...native, sessionId: 'Session-1' };
  bind(f, 'work-with-session', withSession);
  assert.throws(() => bind(f, 'work-with-session', native), code('CONFLICT'));
  f.reopen();
  assert.throws(() => bind(f, 'work-1', withSession), code('CONFLICT'));
  assert.deepEqual(bind(f), replay);
});

test('two host connections serialize identical replays and conflicting associations', t => {
  const f = fixture(t), second = f.open();
  const expected = bind(f);
  assert.deepEqual(second.bind({ conversation: native, kind: 'workflow', id: 'work-1' }), expected);
  assert.throws(() => second.bind({ conversation: { ...native, sessionId: 'different' }, kind: 'workflow', id: 'work-1' }), code('CONFLICT'));
  second.close(); second.close();
  assert.deepEqual(f.store.binding('workflow', 'work-1'), expected);
  assert.equal(f.store.list(native).items.length, 1);
});

test('foreign canonical projects fail without changing stored associations', t => {
  const f = fixture(t); const expected = bind(f); f.store.close();
  const otherProject = join(f.root, 'other-project'); mkdirSync(otherProject);
  const before = readFileSync(f.database);
  assert.throws(() => f.open({ directory: f.directory, projectPath: otherProject }), code('PROJECT'));
  assert.deepEqual(readFileSync(f.database), before);
  f.reopen(); assert.deepEqual(f.store.binding('workflow', 'work-1'), expected);
  database(f, db => db.prepare('UPDATE conversation_work_meta SET project_id=?,project_path=?').run(projectHash(realpathSync(otherProject)), realpathSync(otherProject)));
  assert.throws(() => f.store.binding('workflow', 'work-1'), code('PROJECT'));
  assert.throws(() => bind(f, 'new-work'), code('PROJECT'));
});

test('the pinned project path is validated alongside its hash', t => {
  const f = fixture(t); bind(f);
  database(f, db => db.prepare('UPDATE conversation_work_meta SET project_path=?').run(join(f.root, 'another-path')));
  assert.throws(() => f.store.list(native), code('CORRUPT'));
  f.store.close(); assert.throws(() => f.open(), code('CORRUPT'));
});

test('all operation inputs reject unknown, missing and invalid fields without mutation', t => {
  const f = fixture(t), good = { conversation: native, kind: 'workflow', id: 'work-1' };
  const invalid: unknown[] = [null, [], false, 'metadata', {}, { ...good, prompt: 'private fixture prompt' },
    { ...good, token: 'private fixture token' }, { conversation: native, kind: 'workflow' },
    { ...good, kind: 'work' }, { ...good, id: '' }, { ...good, id: 'x'.repeat(65) },
    { ...good, id: 'workflow:one' }, { ...good, id: '../one' }, { ...good, id: 'one\n' },
    { ...good, conversation: null }, { ...good, conversation: undefined },
    { ...good, conversation: { provider: 'codex', threadId: 'thread' } },
    { ...good, conversation: { ...native, sessionId: undefined } },
    { ...good, conversation: { ...native, provider: 'claude' } },
    { ...good, conversation: { ...native, projectPath: f.project } },
    { ...good, conversation: { ...native, threadId: 'thread'.repeat(52) } },
    { ...good, conversation: { ...native, sessionId: 's'.repeat(257) } },
    { ...good, conversation: { ...native, threadId: ' trimmed ' } },
    { ...good, conversation: { ...native, threadId: 'C:/private/path' } },
    { ...good, conversation: { ...native, threadId: '\u0000thread' } },
    { ...good, conversation: { ...native, threadId: 'é' } }];
  for (const input of invalid) assert.throws(() => invalidBind(f.store, input), code('INPUT'));
  assert.throws(() => f.store.binding('bad' as ConversationWorkKind, 'work-1'), code('INPUT'));
  assert.throws(() => f.store.binding('workflow', 'x'.repeat(65)), code('INPUT'));
  assert.throws(() => f.store.list(native, 'bad' as ConversationWorkKind), code('INPUT'));
  assert.deepEqual(f.store.list(native), { items: [], nextCursor: null });
  assert.equal(f.store.binding('workflow', 'work-1'), null);
});

test('recognized tokens and prompt fields never persist or appear in errors', t => {
  const f = fixture(t);
  for (const value of ['sk-proj-' + 'a'.repeat(24), 'ghp_' + 'b'.repeat(24), 'github_pat_' + 'c'.repeat(24),
    'a'.repeat(64), 'eyJabcde.abcde.abcde', 'token:private-fixture', 'password:private-fixture',
    'arcane_local_v1_8123_' + 'd'.repeat(64)]) {
    let error: unknown;
    try { bind(f, 'work-1', { ...native, threadId: value }); } catch (caught) { error = caught; }
    assert.ok(code('INPUT')(error));
    assert.ok(!(error as Error).message.includes(value));
  }
  assert.throws(() => invalidBind(f.store, { conversation: native, kind: 'workflow', id: 'work-1', prompt: 'never-persist-this-prompt' }), code('INPUT'));
  f.store.close();
  const persisted = readFileSync(f.database).toString('utf8');
  assert.ok(!persisted.includes('never-persist-this-prompt') && !persisted.includes('private-fixture'));
  assert.deepEqual(readdirSync(f.project), []);
  assert.deepEqual(readdirSync(f.directory), ['conversation-work.sqlite']);
});

test('accessors, proxies, symbols, hidden fields and inherited objects are rejected before evaluation', t => {
  const f = fixture(t); let reads = 0;
  const getter = () => { reads++; throw new Error('private getter content'); };
  assert.throws(() => invalidBind(f.store, { get conversation() { return getter(); }, kind: 'workflow', id: 'one' }), code('INPUT'));
  assert.throws(() => bind(f, 'one', { ...native, get threadId() { return getter(); } }), code('INPUT'));
  assert.throws(() => f.store.list(native, undefined, { get limit() { return getter(); } }), code('INPUT'));
  assert.throws(() => new ConversationWorkStore({ get directory() { return getter(); }, projectPath: f.project }), code('INPUT'));
  assert.throws(() => invalidBind(f.store, Object.create({ conversation: native, kind: 'workflow', id: 'one' })), code('INPUT'));
  assert.throws(() => invalidBind(f.store, { conversation: native, kind: 'workflow', id: 'one', [Symbol('hidden')]: true }), code('INPUT'));
  const hidden = { conversation: native, kind: 'workflow', id: 'one' }; Object.defineProperty(hidden, 'prompt', { value: 'private' });
  assert.throws(() => invalidBind(f.store, hidden), code('INPUT'));
  const proxied = new Proxy({ conversation: native, kind: 'workflow', id: 'one' }, { getPrototypeOf: getter });
  assert.throws(() => invalidBind(f.store, proxied), code('INPUT'));
  assert.equal(reads, 0);
  const own = Object.assign(Object.create(null) as NativeConversation, native);
  assert.equal(bind(f, 'own-fields', own).conversation.threadId, native.threadId);
});

test('construction is strictly shaped and identity accessors cannot mutate private storage', t => {
  const f = fixture(t);
  for (const value of [{ directory: f.directory }, { directory: f.directory, projectPath: f.project, token: 'private' }, null]) {
    assert.throws(() => new ConversationWorkStore(value as ConstructorParameters<typeof ConversationWorkStore>[0]), code('INPUT'));
  }
  const projectId = f.store.projectId;
  assert.equal(Reflect.set(f.store, 'projectId', 'forged'), false);
  assert.equal(Reflect.set(f.store, 'projectPath', 'forged'), false);
  assert.deepEqual(Object.keys(f.store), []);
  const view = f.store as unknown as Record<string, unknown>;
  assert.equal(view.db, undefined); assert.equal(view.databasePath, undefined); assert.equal(view.directory, undefined);
  assert.equal(bind(f).projectId, projectId);
});

test('pagination is bounded, stable across restart and includes later insertions without duplicates', t => {
  const f = fixture(t);
  const ids = Array.from({ length: 205 }, (_, i) => 'item-' + i);
  for (const [i, id] of ids.entries()) bind(f, id, native, i % 2 ? 'asset-job' : 'workflow');
  assert.equal(f.store.list(native).items.length, 100);
  const first = f.store.list(native, undefined, { limit: 70 });
  assert.equal(first.items.length, 70); assert.ok(first.nextCursor);
  f.reopen(); bind(f, 'inserted-later', native, 'asset-job');
  const collected = first.items.map(item => item.id);
  let cursor: string | null = first.nextCursor;
  while (cursor !== null) {
    const page = f.store.list(native, undefined, { limit: 70, after: cursor });
    assert.ok(page.items.length <= 70 && Buffer.byteLength(JSON.stringify(page)) <= CONVERSATION_WORK_LIMITS.pageBytes);
    collected.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
  }
  assert.deepEqual(collected, [...ids, 'inserted-later']);
  assert.equal(new Set(collected).size, collected.length);
  const workflows = f.store.list(native, 'workflow');
  const remainder = f.store.list(native, 'workflow', { after: workflows.nextCursor! });
  assert.equal(workflows.items.length + remainder.items.length, 103);
  assert.ok([...workflows.items, ...remainder.items].every(item => item.kind === 'workflow'));
});

test('pagination rejects invalid bounds/fields and cursors from any other exact scope', t => {
  const f = fixture(t); bind(f, 'one'); bind(f, 'two');
  const page = f.store.list(native, undefined, { limit: 1 }), cursor = page.nextCursor!;
  const badPages: unknown[] = [null, [], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Infinity },
    { limit: '1' }, { limit: undefined }, { offset: 0 }, { after: null }, { after: undefined },
    { after: '' }, { after: 'x'.repeat(1024) }, { after: cursor.slice(0, 65) + '9007199254740992' },
    { after: cursor.slice(0, 65) + '4096' }];
  for (const input of badPages) assert.throws(() => f.store.list(native, undefined, input as ConversationWorkPagination), code('INPUT'));
  for (const changed of [{ ...native, provider: 'claude-code' as const }, { ...native, threadId: 'different' }, { ...native, sessionId: 'session' }]) {
    assert.throws(() => f.store.list(changed, undefined, { after: cursor }), code('INPUT'));
  }
  assert.throws(() => f.store.list(native, 'workflow', { after: cursor }), code('INPUT'));
  const other = fixture(t); bind(other, 'one'); bind(other, 'two');
  assert.throws(() => other.store.list(native, undefined, { after: cursor }), code('INPUT'));
  assert.equal(f.store.list(native, undefined, { after: cursor }).items[0]?.id, 'two');
});

test('maximum native/work ID lengths and a full page remain below the complete byte bound', t => {
  const f = fixture(t), long = { ...native, threadId: 'T'.repeat(256), sessionId: 'S'.repeat(256) };
  for (let i = 0; i < 100; i++) bind(f, String(i).padStart(64, '_'), long, 'asset-job');
  const page = f.store.list(long, 'asset-job', { limit: 100 });
  assert.equal(page.items.length, 100); assert.equal(page.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CONVERSATION_WORK_LIMITS.pageBytes);
  assert.equal(page.items[0]?.conversation.threadId.length, 256);
});

test('close is idempotent and every valid host operation fails after close', t => {
  const f = fixture(t); bind(f); f.store.close(); f.store.close();
  assert.throws(() => bind(f), code('CLOSED'));
  assert.throws(() => f.store.binding('workflow', 'work-1'), code('CLOSED'));
  assert.throws(() => f.store.list(native), code('CLOSED'));
  f.reopen(); assert.equal(f.store.list(native).items.length, 1);
});

test('empty version-zero SQLite migrates once; nonempty unversioned and future versions are unchanged', t => {
  const f = fixture(t); f.store.close(); unlinkSync(f.database);
  database(f, db => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0));
  f.reopen(); bind(f); f.reopen(); assert.equal(f.store.list(native).items.length, 1);
  for (const [statement, expected] of [['PRAGMA user_version=99', 'MIGRATION'], ['PRAGMA user_version=-1', 'CORRUPT'], ['PRAGMA user_version=0', 'CORRUPT'], ['PRAGMA application_id=1', 'CORRUPT']] as const) {
    const changed = fixture(t); changed.store.close(); database(changed, db => db.exec(statement));
    const before = readFileSync(changed.database);
    assert.throws(() => changed.open(), code(expected));
    assert.deepEqual(readFileSync(changed.database), before);
  }
});

test('nonempty foreign version-zero SQLite is refused without adopting or repairing it', t => {
  const f = fixture(t); f.store.close(); unlinkSync(f.database);
  database(f, db => db.exec('CREATE TABLE provider_content (payload TEXT) STRICT; INSERT INTO provider_content VALUES(\'offline foreign fixture\');'));
  const before = readFileSync(f.database);
  assert.throws(() => f.open(), code('CORRUPT')); assert.deepEqual(readFileSync(f.database), before);
});

test('unexpected/missing schema and raw corrupt SQLite fail closed without reset', t => {
  for (const statement of ['CREATE TABLE unexpected(payload TEXT) STRICT', 'DROP INDEX conversation_work_by_native',
    'CREATE INDEX unexpected ON conversation_work_bindings(work_id)', 'DROP TABLE conversation_work_meta',
    "CREATE TRIGGER unexpected AFTER INSERT ON conversation_work_bindings BEGIN DELETE FROM conversation_work_bindings; END"]) {
    const f = fixture(t); f.store.close(); database(f, db => db.exec(statement));
    const before = readFileSync(f.database);
    assert.throws(() => f.open(), code('CORRUPT')); assert.deepEqual(readFileSync(f.database), before);
  }
  const f = fixture(t); f.store.close(); writeFileSync(f.database, 'offline corrupt database fixture');
  assert.throws(() => f.open(), code('CORRUPT'));
  assert.equal(readFileSync(f.database, 'utf8'), 'offline corrupt database fixture');
});

test('live schema/version corruption blocks reads and binds, preserving existing association rows', t => {
  const f = fixture(t); bind(f);
  database(f, db => db.exec('CREATE TABLE unexpected(payload TEXT) STRICT'));
  assert.throws(() => f.store.binding('workflow', 'work-1'), code('CORRUPT'));
  assert.throws(() => f.store.list(native), code('CORRUPT'));
  assert.throws(() => bind(f, 'not-inserted'), code('CORRUPT'));
  database(f, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_work_bindings').get()?.n, 1);
    db.exec('DROP TABLE unexpected; PRAGMA user_version=2');
  });
  assert.throws(() => f.store.list(native), code('MIGRATION'));
});

test('corrupt stored native, work, provider and project metadata cannot be returned or overwritten', t => {
  const updates = ["UPDATE conversation_work_bindings SET thread_id='bad/path'", "UPDATE conversation_work_bindings SET session_id=''",
    "UPDATE conversation_work_bindings SET work_id='bad:path'", "PRAGMA ignore_check_constraints=ON; UPDATE conversation_work_bindings SET provider='claude'",
    "PRAGMA ignore_check_constraints=ON; UPDATE conversation_work_bindings SET kind='unknown'",
    'UPDATE conversation_work_bindings SET sequence=9223372036854775807',
    "UPDATE conversation_work_bindings SET session_id='sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa'",
    'DELETE FROM conversation_work_meta', "UPDATE conversation_work_meta SET project_id='invalid'"];
  for (const statement of updates) {
    const f = fixture(t); bind(f); database(f, db => db.exec(statement));
    assert.throws(() => f.store.list(native), code('CORRUPT'));
    assert.throws(() => bind(f), code('CORRUPT'));
    f.store.close(); assert.throws(() => f.open(), code('CORRUPT'));
  }
  const oversized = fixture(t); bind(oversized);
  database(oversized, db => db.prepare('UPDATE conversation_work_bindings SET thread_id=?').run('x'.repeat(CONVERSATION_WORK_LIMITS.recordBytes + 1)));
  assert.throws(() => oversized.store.list(native), code('CORRUPT'));
});

test('capacity has no pruning and identical replays still succeed at the hard binding limit', t => {
  const f = fixture(t);
  database(f, db => {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare("INSERT INTO conversation_work_bindings VALUES(?,'workflow',?,'codex',?,NULL)");
    for (let i = 1; i <= CONVERSATION_WORK_LIMITS.bindings; i++) insert.run(i, 'capacity-' + i, native.threadId);
    db.exec('COMMIT');
  });
  assert.equal(bind(f, 'capacity-1').id, 'capacity-1');
  assert.throws(() => bind(f, 'overflow'), code('CAPACITY'));
  assert.equal(f.store.list(native).items.length, 100);
  database(f, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_work_bindings').get()?.n, CONVERSATION_WORK_LIMITS.bindings);
    db.prepare("INSERT INTO conversation_work_bindings VALUES(?,'workflow','corrupt-overflow','codex',?,NULL)").run(CONVERSATION_WORK_LIMITS.bindings + 1, native.threadId);
  });
  assert.throws(() => f.store.list(native), code('CORRUPT'));
});

test('direct paths reject traversal, roots, provider/config locations and unsafe Windows syntax', t => {
  const f = fixture(t);
  const unsafe = ['relative', parse(f.project).root, f.project + sep + '..' + sep + 'project', f.project + '\u0000',
    ...['.codex', '.claude', '.git', '.agents', '.aws', '.azure', '.ssh', '.gnupg', '.env', '.env.local'].map(part => join(f.root, part, 'state'))];
  if (process.platform === 'win32') unsafe.push('\\\\server\\share\\state', '\\\\?\\C:\\state', f.project + ':stream', join(f.root, 'NUL'), join(f.root, 'trailing.'));
  for (const path of unsafe) {
    assert.throws(() => f.open({ directory: path, projectPath: f.project }), code('PATH'));
    assert.throws(() => f.open({ directory: f.directory, projectPath: path }), code('PATH'));
  }
  const privateState = join(f.root, '.CODEX'); assert.ok(!readdirSync(f.root).includes('.CODEX'));
  assert.throws(() => f.open({ directory: privateState, projectPath: f.project }), code('PATH'));
  assert.ok(!readdirSync(f.root).includes('.CODEX'));
  const arcane = f.open({ directory: join(f.project, '.arcane'), projectPath: f.project });
  assert.equal(arcane.projectId, f.store.projectId);
  assert.throws(() => f.open({ directory: f.directory, projectPath: join(f.root, 'missing') }), code('PATH'));
});

test('project/state junctions and linked ancestors are rejected without touching targets', t => {
  const f = fixture(t); bind(f); f.store.close(); const before = readFileSync(f.database);
  const projectLink = join(f.root, 'project-link'), stateLink = join(f.root, 'state-link'), ancestor = join(f.root, 'ancestor-link');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(f.project, projectLink, type); symlinkSync(f.directory, stateLink, type); symlinkSync(f.root, ancestor, type);
  assert.throws(() => f.open({ directory: f.directory, projectPath: projectLink }), code('PATH'));
  assert.throws(() => f.open({ directory: stateLink, projectPath: f.project }), code('PATH'));
  assert.throws(() => f.open({ directory: join(ancestor, 'new-state'), projectPath: f.project }), code('PATH'));
  assert.ok(!readdirSync(f.root).includes('new-state'));
  assert.deepEqual(readFileSync(f.database), before);
});

test('SQLite main/WAL/SHM/journal hard links and nonregular files fail before SQLite opens them', t => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = fixture(t); bind(f); f.store.close();
    const original = readFileSync(f.database), source = join(f.root, 'link-source');
    if (!suffix) linkSync(f.database, source);
    else { writeFileSync(source, 'untouched sidecar fixture'); linkSync(source, f.database + suffix); }
    assert.throws(() => f.open(), code('PATH'));
    assert.deepEqual(readFileSync(f.database), original);
    if (suffix) assert.equal(readFileSync(source, 'utf8'), 'untouched sidecar fixture');
  }
  const f = fixture(t); f.store.close(); unlinkSync(f.database); mkdirSync(f.database);
  assert.throws(() => f.open(), code('PATH'));
});

test('live access rechecks single links and missing/replaced database paths', t => {
  const f = fixture(t); bind(f);
  const alias = join(f.root, 'live-alias'); linkSync(f.database, alias);
  assert.throws(() => f.store.binding('workflow', 'work-1'), code('PATH'));
  assert.throws(() => bind(f, 'new-work'), code('PATH'));
  assert.throws(() => f.store.list(native), code('PATH'));
  unlinkSync(alias); assert.equal(f.store.list(native).items.length, 1);
  // Open SQLite handles can disallow unlink on Windows; hard-link rechecks cover that platform.
  if (process.platform !== 'win32') {
    unlinkSync(f.database); assert.throws(() => f.store.list(native), code('PATH'));
    writeFileSync(f.database, 'replacement'); assert.throws(() => f.store.list(native), code('PATH'));
  }
});

test('oversized database and sidecars fail bounded preflight without reading or modifying them', t => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = fixture(t); f.store.close();
    const path = f.database + suffix;
    if (suffix) writeFileSync(path, 'fixture');
    truncateSync(path, CONVERSATION_WORK_LIMITS.fileBytes + 1);
    const size = lstatSync(path).size;
    assert.throws(() => f.open(), code('CAPACITY'));
    assert.equal(lstatSync(path).size, size);
  }
});

test('simultaneous SQLite writers commit one association: replay succeeds and conflicting identity loses', { timeout: 20000 }, async t => {
  const workers = new Set<Worker>();
  t.after(async () => { await Promise.all([...workers].map(worker => worker.terminate())); });
  const f = fixture(t);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { ConversationWorkStore } = await import(workerData.module);
      const store = new ConversationWorkStore(workerData.options);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10000);
      let result;
      try {
        store.bind({ conversation: workerData.conversation, kind: 'workflow', id: workerData.id });
        result = { type: 'result', ok: true };
      } catch (error) { result = { type: 'result', ok: false, code: error.code }; }
      finally { store.close(); }
      parentPort.postMessage(result);
    })().catch(() => parentPort.postMessage({ type: 'failed' }));
  `;
  for (const scenario of ['identical', 'conflict']) {
    const barrier = new SharedArrayBuffer(4);
    function start(conversation: NativeConversation) {
      let markReady!: () => void;
      let markResult!: (value: { ok: boolean; code?: string }) => void;
      let failResult!: (error: Error) => void;
      const ready = new Promise<void>(resolve => { markReady = resolve; });
      const result = new Promise<{ ok: boolean; code?: string }>((resolve, reject) => { markResult = resolve; failResult = reject; });
      // Observe initialization errors immediately, then rethrow them when awaiting the result.
      void result.catch(() => {});
      const worker = new Worker(workerSource, { eval: true, workerData: {
        module: new URL('../../packages/storage/src/conversation-work-store.js', import.meta.url).href,
        options: { directory: f.directory, projectPath: f.project }, barrier, conversation, id: scenario,
      } });
      workers.add(worker);
      let completed = false;
      worker.on('message', (message: { type: string; ok: boolean; code?: string }) => {
        if (message.type === 'ready') markReady();
        else if (message.type === 'result') { completed = true; markResult(message); }
        else { markReady(); failResult(new Error('Offline association worker failed.')); }
      });
      worker.on('error', error => { markReady(); failResult(error); });
      worker.on('exit', () => { if (!completed) { markReady(); failResult(new Error('Association worker exited before its result.')); } });
      return { ready, result };
    }
    const candidates = [start(native), start(scenario === 'identical' ? native : { ...native, sessionId: 'competing-session' })];
    await Promise.all(candidates.map(candidate => candidate.ready));
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    const results = await Promise.all(candidates.map(candidate => candidate.result));
    if (scenario === 'identical') assert.ok(results.every(result => result.ok));
    else {
      assert.equal(results.filter(result => result.ok).length, 1);
      assert.equal(results.find(result => !result.ok)?.code, 'CONVERSATION_WORK_CONFLICT');
    }
    assert.ok(f.store.binding('workflow', scenario));
  }
  database(f, db => assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_work_bindings').get()?.n, 2));
});
