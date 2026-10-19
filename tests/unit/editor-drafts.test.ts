import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorDraftStore, readEditorDraftSnapshot, type EditorDraft, type EditorDraftInput, type EditorDraftSnapshot, type EditorDraftBridge} from '../../apps/desktop/src/editor-drafts.js';
const projectPath = 'C:\\Project';
const memory = (text = '  Unsaved notes\n\n\u{1f332}  '): EditorDraftInput => ({kind: 'project-memory', title: 'Project memory', context: 'project-memory', baseline: 'Saved notes', text});
const row = (value = memory()): EditorDraft => ({id: 'draft:fixture', ...value});
const snapshot = (drafts = [row()]): EditorDraftSnapshot => ({version: 1, projectPath, drafts});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const readable = (preferences: EditorDraftSnapshot | null = null) => ({available: true, projectPath, preferences});
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => resolve = done); return {promise, resolve}; };
const settle = async () => {for (let i = 0; i < 15; i++) await Promise.resolve();};

test('editor draft snapshots retain exact text and context and reject unknown, augmented and oversized data', () => {
  const value = snapshot(); assert.deepEqual(readEditorDraftSnapshot(value), value);
  for (const invalid of [{...value, version: 2}, {...value, credentials: 'forbidden'}, {...value, drafts: [row(), row()]},
    snapshot([{...row(), kind: 'api-key'} as unknown as EditorDraft]), snapshot([{...row(), context: 'another-memory'}]),
    snapshot([{...row(), text: 'x'.repeat(16385)}]), snapshot([{...row(), title: 'bad\nlabel'}])]) assert.throws(() => readEditorDraftSnapshot(invalid));
  const result = readEditorDraftSnapshot(value); result.drafts[0]!.text = 'Caller mutation'; assert.deepEqual(value, snapshot());
});

test('edits queued before native hydration retain their captured input and original project identity', async () => {
  const read = gate<unknown>(), saves: EditorDraftSnapshot[] = [], store = new EditorDraftStore({version: 1, read: () => read.promise,
    save: async value => {saves.push(copy(value)); return {saved: true};}});
  const input = memory(), expected = copy(input), saving = store.save(input); input.text = 'Late caller edit';
  read.resolve(readable(snapshot([row(memory('Previously stored draft'))]))); await saving;
  assert.equal(saves.length, 1); assert.equal(saves[0]!.projectPath, projectPath); assert.deepEqual(saves[0]!.drafts[0], {id: 'draft:fixture', ...expected});
  assert.equal(await store.readyForRuntimeRecovery(), true);
});

test('a failed native save retains the desired draft and checkpoint retries presentation storage only', async () => {
  let failed = true, saved: EditorDraftSnapshot | null = null, writes = 0;
  const store = new EditorDraftStore({version: 1, read: async () => readable(), save: async value => {writes++; if (failed) throw Error('Private draft text'); saved = copy(value); return {saved: true};}});
  await assert.rejects(store.save(memory())); assert.equal((await store.get('project-memory', 'project-memory'))!.text, memory().text);
  assert.equal(await store.readyForRuntimeRecovery(), false); failed = false; await store.checkpoint();
  assert.equal(writes, 2); assert.deepEqual((saved as unknown as EditorDraftSnapshot).drafts[0]!.text, memory().text); assert.equal(await store.readyForRuntimeRecovery(), true);
});

test('serialized writes and exact discard prevent older save results from clearing newer text', async () => {
  const hold = gate<unknown>(), saves: EditorDraftSnapshot[] = [];
  const store = new EditorDraftStore({version: 1, read: async () => readable(), save: async value => {saves.push(copy(value)); return saves.length === 1 ? hold.promise : {saved: true};}});
  const first = store.save(memory('First draft')); await settle(); assert.equal(saves.length, 1);
  const old = copy(saves[0]!.drafts[0]!), second = store.save(memory('Second draft')), discard = store.discard(old);
  hold.resolve({saved: true}); await Promise.all([first, second, discard]);
  assert.equal(saves.length, 2); assert.equal((await store.get('project-memory', 'project-memory'))!.text, 'Second draft');
  await store.save(memory('Saved notes')); assert.deepEqual((await store.list()), []); assert.deepEqual(saves.at(-1)!.drafts, []);
});

test('corrupt, foreign and unavailable native records never receive replacement writes', async () => {
  for (const reply of [{available: true, projectPath, preferences: {...snapshot(), projectPath: 'C:\\Other'}}, {available: true, projectPath, preferences: {version: 9}},
    {available: false, projectPath: null, preferences: null}, {available: true, projectPath, preferences: null, token: 'forbidden'}]) {
    let writes = 0; const store = new EditorDraftStore({version: 1, read: async () => reply, save: async () => {writes++; return {saved: true};}});
    await assert.rejects(store.save(memory())); await assert.rejects(store.checkpoint()); assert.equal(await store.readyForRuntimeRecovery(), false); assert.equal(writes, 0);
  }
});

test('native acknowledgements must be exact and draft limits never evict an unsaved record', async () => {
  let reply: unknown = {saved: false}; const store = new EditorDraftStore({version: 1, read: async () => readable(), save: async () => reply});
  await assert.rejects(store.save(memory())); reply = {saved: true, extra: true}; await assert.rejects(store.checkpoint());
  reply = {saved: true}; await store.checkpoint();
  for (let i = 0; i < 15; i++) await store.save({kind: 'script-source', title: 'Script '+i, context: 'target:'+i, baseline: '', text: 'print('+i+')'});
  await assert.rejects(store.save({kind: 'script-source', title: 'Overflow draft', context: 'target:overflow', baseline: '', text: 'Still in memory'}));
  assert.equal((await store.list()).length, 17, 'An over-limit desired draft is retained in memory rather than evicting an older entry.');
  assert.equal(await store.readyForRuntimeRecovery(), false);
  const overflow = (await store.list()).find(item => item.context === 'target:overflow')!; await store.discard(overflow);
  assert.equal((await store.list()).length, 16); assert.equal(await store.readyForRuntimeRecovery(), true);
});
