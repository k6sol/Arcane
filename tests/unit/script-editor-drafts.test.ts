import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorDraftStore, type EditorDraft, type EditorDraftSnapshot} from '../../apps/desktop/src/editor-drafts.js';
import {startScriptEditorDrafts, type AppliedScriptDraft, type ScriptDraftTarget} from '../../apps/desktop/src/script-editor-drafts.js';

// Document and native-bridge fixtures only. No Studio, daemon, provider or browser storage.
const projectPath = 'C:\\Project', CONTEXT = '{"instanceId":"script-1"}', BASELINE = 'print("saved")';
const settle = async (count = 20) => {for (let i = 0; i < count; i++) await new Promise<void>(done => setImmediate(done));};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Listener = (event: {isTrusted: boolean}) => void;
class Node {
  id = ''; children: Node[] = []; value = ''; hidden = false; open = false; disabled = false; readOnly = false; spellcheck = true;
  rows = 0; className = ''; type = ''; parent: Node | null = null; private content = ''; private listeners = new Map<string, Set<Listener>>();
  constructor(readonly tagName: string) {}
  get textContent(): string {return this.content + this.children.map(child => child.textContent).join('');}
  set textContent(value: string) {this.content = value; this.children = [];}
  setAttribute() {} append(...children: Node[]) {this.children.push(...children);}
  replaceChildren(...children: Node[]) {this.content = ''; this.children = children;}
  get parentElement() {return this.parent;}
  closest(selector: string): Node | null {let node = this.parent; while (node && node.tagName !== selector) node = node.parent; return node;}
  inserted: Node[] = []; before(...nodes: Node[]) {this.inserted.push(...nodes);}
  addEventListener(type: string, listener: Listener) {const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set);}
  removeEventListener(type: string, listener: Listener) {this.listeners.get(type)?.delete(listener);}
  emit(type: string, isTrusted = true) {for (const listener of [...this.listeners.get(type) ?? []]) listener({isTrusted});}
}
function fixture(stored: EditorDraft[] = [], save: (value: EditorDraftSnapshot) => Promise<unknown> = async () => ({saved: true})) {
  const form = new Node('form'), source = new Node('textarea'); source.id = 'source'; source.parent = form; source.value = BASELINE;
  const doc = {getElementById: (id: string) => id === 'source' ? source : null, createElement: (tag: string) => new Node(tag)} as unknown as Document;
  const saves: EditorDraftSnapshot[] = [];
  const store = new EditorDraftStore({version: 1, read: async () => ({available: true, projectPath, preferences: stored.length ? {version: 1, projectPath, drafts: stored} : null}),
    save: async value => {const reply = await save(value); saves.push(copy(value)); return reply;}});
  const target: ScriptDraftTarget = {context: CONTEXT, title: 'Workspace / Script', baseline: BASELINE, canRestore: true};
  const restored: EditorDraft[] = [], cleared: EditorDraft[] = [], contexts = new Set<() => void>(), applied = new Set<(value: AppliedScriptDraft) => void>();
  const drafts = startScriptEditorDrafts(doc, {drafts: store, target: () => ({...target}),
    restore: value => {if (value.context !== target.context || value.baseline !== target.baseline) return false; restored.push(value); source.value = value.text; return true;},
    clear: value => {if (source.value !== value.text) return false; cleared.push(value); source.value = target.baseline; return true;},
    subscribeContext: listener => {contexts.add(listener); return () => contexts.delete(listener);},
    subscribeApplied: listener => {applied.add(listener); return () => applied.delete(listener);}});
  const panel = form.inserted[0]!;
  const cards = () => panel.children[2]!.children.map(article => ({title: article.children[0]!.textContent, text: article.children[1]!.value,
    note: article.children[2]!.textContent, restore: article.children[3]!, discard: article.children[4]!}));
  const type = (text: string) => {source.value = text; source.emit('input');};
  return {source, store, saves, drafts, panel, cards, type, restored, cleared, applied, status: () => panel.children[1]!.textContent};
}
const storedRow = (text = 'print("draft")'): EditorDraft => ({id: 'draft:script', kind: 'script-source', title: 'Workspace / Script', context: CONTEXT, baseline: BASELINE, text});

test('typed script source is saved as a draft bound to the exact editor context and baseline', async () => {
  const view = fixture(); await settle();
  assert.equal(view.panel.hidden, true, 'no panel while no draft exists');
  view.type('print("unsaved edit")'); await view.drafts.prepareForRestart(); await settle();
  const row = await view.store.get('script-source', CONTEXT);
  assert.deepEqual({...row, id: undefined}, {id: undefined, kind: 'script-source', title: 'Workspace / Script', context: CONTEXT, baseline: BASELINE, text: 'print("unsaved edit")'});
  assert.equal(view.saves.at(-1)!.drafts.length, 1); assert.equal(view.panel.hidden, false);
  assert.equal(await view.drafts.readyForRuntimeRecovery(), true); view.drafts.stop();
});

test('a stored draft is restored into the editor only on a trusted click and never on an untrusted one', async () => {
  const view = fixture([storedRow()]); await settle();
  const [card] = view.cards(); assert.ok(card); assert.equal(card.text, 'print("draft")'); assert.equal(card.restore.disabled, false);
  assert.match(card.note, /does not submit a command/);
  card.restore.emit('click', false); assert.equal(view.source.value, BASELINE); assert.equal(view.restored.length, 0);
  card.restore.emit('click'); assert.equal(view.source.value, 'print("draft")'); assert.equal(view.restored.length, 1);
  await view.drafts.prepareForRestart(); assert.equal((await view.store.get('script-source', CONTEXT))!.text, 'print("draft")');
  view.drafts.stop();
});

test('discarding a draft removes it from native storage and clears the restored editor text', async () => {
  const view = fixture([storedRow()]); await settle();
  view.cards()[0]!.restore.emit('click'); await settle();
  view.cards()[0]!.discard.emit('click'); await settle();
  assert.equal(view.source.value, BASELINE); assert.equal(view.cleared.length, 1);
  assert.equal(await view.store.get('script-source', CONTEXT), null); assert.deepEqual(view.saves.at(-1)!.drafts, []);
  assert.equal(view.panel.hidden, true); assert.equal(await view.drafts.readyForRuntimeRecovery(), true); view.drafts.stop();
});

test('a discard whose native write fails rolls back the stored draft and the editor text', async () => {
  let failing = false; const view = fixture([storedRow()], async () => {if (failing) throw new Error('disk full'); return {saved: true};});
  await settle(); view.cards()[0]!.restore.emit('click'); await view.drafts.prepareForRestart(); await settle();
  failing = true; view.cards()[0]!.discard.emit('click'); await settle();
  assert.equal((await view.store.get('script-source', CONTEXT))!.text, 'print("draft")', 'the store keeps the record after a failed discard');
  assert.equal(view.source.value, 'print("draft")', 'the editor text is put back after a failed discard');
  assert.match(view.status(), /could not finish/); assert.equal(view.cards().length, 1);
  assert.equal(await view.drafts.readyForRuntimeRecovery(), false);
  failing = false; await view.drafts.prepareForRestart(); await settle();
  assert.equal(view.saves.at(-1)!.drafts[0]!.text, 'print("draft")'); assert.equal(await view.drafts.readyForRuntimeRecovery(), true);
  view.drafts.stop();
});

test('store discard reports whether it removed the exact record and restores it when persistence fails', async () => {
  let failing = false, writes = 0;
  const store = new EditorDraftStore({version: 1, read: async () => ({available: true, projectPath, preferences: {version: 1, projectPath, drafts: [storedRow()]}}),
    save: async () => {writes++; if (failing) throw new Error('disk full'); return {saved: true};}});
  assert.equal(await store.discard(storedRow('print("other")')), false, 'a stale record is never discarded'); assert.equal(writes, 0);
  failing = true; await assert.rejects(store.discard(storedRow()));
  assert.deepEqual(await store.get('script-source', CONTEXT), storedRow()); assert.equal(await store.readyForRuntimeRecovery(), false);
  failing = false; assert.equal(await store.discard(storedRow()), true);
  assert.equal(await store.get('script-source', CONTEXT), null); assert.equal(await store.readyForRuntimeRecovery(), true);
});

test('a confirmed source update settles the matching draft instead of offering stale text', async () => {
  const view = fixture([storedRow()]); await settle();
  view.cards()[0]!.restore.emit('click'); await view.drafts.prepareForRestart(); await settle();
  for (const listener of view.applied) listener({context: CONTEXT, baseline: BASELINE, text: 'print("draft")'});
  await settle(); await view.drafts.prepareForRestart(); await settle();
  assert.equal(await view.store.get('script-source', CONTEXT), null, 'an applied draft is removed rather than kept as a recovery prompt');
  view.drafts.stop();
});
