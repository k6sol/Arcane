/// <reference lib="dom" />
import type {EditorDraft, EditorDraftInput, EditorDraftStore} from './editor-drafts.js';
export interface ScriptDraftTarget {context: string; title: string; baseline: string; canRestore: boolean}
export interface AppliedScriptDraft {context: string; baseline: string; text: string}
export interface ScriptDraftOptions {
  drafts: EditorDraftStore | null;
  target(): ScriptDraftTarget | null;
  restore(value: EditorDraft): boolean;
  clear(value: EditorDraft): boolean;
  subscribeContext(listener: () => void): () => void;
  subscribeApplied(listener: (value: AppliedScriptDraft) => void): () => void;
}
/** Explicit recovery of presentation text. Stored contexts are compared, never resolved into targets or commands. */
export function startScriptEditorDrafts(doc: Document, options: ScriptDraftOptions) {
  const input = doc.getElementById('source') as HTMLTextAreaElement | null;
  const panel = doc.createElement('details'); panel.id = 'script-draft-panel'; panel.className = 'settings-group'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Recovered script drafts');
  const heading = doc.createElement('summary'); heading.textContent = 'Script drafts';
  const status = doc.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status');
  const cards = doc.createElement('div'); panel.append(heading, status, cards);
  if (options.drafts && input) (input.closest('form') ?? input.parentElement)?.before(panel);
  let stopped = false, lifecycle = 0, renderVersion = 0, edited = false, working = false, failure = false, initialized = false;
  let timer: ReturnType<typeof setTimeout> | null = null, operations = Promise.resolve();
  let removeContext: (() => void) | null = null, removeApplied: (() => void) | null = null;
  const pending = new Map<string, EditorDraftInput>(), applied: AppliedScriptDraft[] = [], receipts: AppliedScriptDraft[] = [];
  function effectiveBaseline(context: string, baseline: string | null): string | null {
    for (const value of applied) if (value.context === context && value.baseline === baseline) baseline = value.text;
    return baseline;
  }
  const clearTimer = () => {if (timer !== null) clearTimeout(timer); timer = null;};
  function capture() {
    if (!input || !edited) return;
    const target = options.target(); if (!target) return;
    const baseline = effectiveBaseline(target.context, target.baseline);
    pending.set(target.context, {kind: 'script-source', title: target.title, context: target.context, baseline, text: input.value});
  }
  async function render(): Promise<void> {
    if (!options.drafts || !input) return;
    const version = ++renderVersion, generation = lifecycle;
    let rows: EditorDraft[];
    try {rows = await options.drafts.list('script-source');}
    catch {if (!stopped && generation === lifecycle && version === renderVersion) {failure = true; panel.hidden = false; status.textContent = 'Stored script drafts could not be read. Existing records were retained.';} return;}
    if (stopped || generation !== lifecycle || version !== renderVersion) return;
    const pendingContexts = new Set(pending.keys());
    const transient = new Map<EditorDraft, EditorDraft | null>();
    for (const value of pending.values()) {
      const item = {...value, id: 'pending:' + crypto.randomUUID()};
      transient.set(item, rows.find(row => row.context === item.context) ?? null);
    }
    rows = [...rows.filter(row => !pendingContexts.has(row.context)), ...transient.keys()];
    const target = options.target(); panel.hidden = !rows.length && !failure;
    heading.textContent = 'Script drafts' + (rows.length ? ' (' + rows.length + ')' : '');
    if (!initialized) {panel.open = !!rows.length; initialized = true;} else if (failure) panel.open = true;
    status.textContent = failure ? 'Draft backup could not finish. Keep this window open and try again.' : 'Drafts stay separate from Studio. Read the original script before restoring; submit changes explicitly.';
    const content = rows.map(row => {
      const article = doc.createElement('article'), title = doc.createElement('h4'), source = doc.createElement('textarea');
      title.textContent = row.title || 'Script draft'; source.className = 'script-draft-text'; source.rows = 6; source.readOnly = true; source.spellcheck = false; source.value = row.text;
      source.setAttribute('aria-label', 'Stored source for ' + (row.title || 'script draft'));
      const note = doc.createElement('p'); note.className = 'hint';
      const same = target?.context === row.context, baseline = same && target.baseline === row.baseline;
      const clean = !!target && (input.value === target.baseline || input.value === row.text);
      note.textContent = !same ? 'Choose the original script and read its current source to restore this draft.' : !baseline ? 'The source has changed. Review or copy this draft before merging.' : !clean ? 'Your current edit is newer. Keep or clear it before restoring another draft.' : 'Restoring fills the editor. It does not submit a command.';
      const restore = doc.createElement('button'), discard = doc.createElement('button'); restore.type = discard.type = 'button';
      restore.textContent = 'Restore to editor'; discard.textContent = 'Discard draft'; discard.className = 'secondary';
      restore.disabled = working || !target?.canRestore || !same || !baseline || !clean; discard.disabled = working;
      restore.addEventListener('click', event => {
        if (!event.isTrusted || stopped || working || !options.restore(row)) return;
        edited = true; capture(); schedule(); void render();
      });
      discard.addEventListener('click', event => {
        if (!event.isTrusted || stopped || working) return;
        const pendingOnly = transient.has(row), stored = pendingOnly ? transient.get(row) : row;
        const value = pending.get(row.context);
        if (value?.text === row.text && value.baseline === row.baseline) pending.delete(row.context);
        const cleared = options.clear(row); if (cleared) edited = false;
        if (!stored) {void flush().catch(() => {}); return;}
        const generation = lifecycle; working = true; void render();
        void options.drafts!.discard(stored).then(() => {if (generation === lifecycle) failure = false;}).catch(() => {
          pending.set(row.context, pending.get(row.context) ?? {kind: row.kind, title: row.title, context: row.context, baseline: row.baseline, text: row.text});
          if (cleared && options.restore(row)) {edited = true; capture();}
          if (generation === lifecycle) failure = true;
        })
          .finally(() => {if (generation === lifecycle) {working = false; void render();}});
      });
      article.append(title, source, note, restore, discard); return article;
    });
    cards.replaceChildren(...content);
  }
  function flush(): Promise<void> {
    clearTimer();
    const task = operations.then(async () => {
      if (!options.drafts) {if (pending.size) throw new Error('Script drafts could not be stored. Keep this window open.'); return;}
      const updates = [...pending.values()], settled = receipts.splice(0); pending.clear();
      for (let i = 0; i < settled.length; i++) {
        const value = settled[i]!;
        try {
          const row = await options.drafts.get('script-source', value.context);
          if (row?.baseline === value.baseline) {
            if (row.text === value.text) await options.drafts.discard(row);
            else await options.drafts.save({...row, baseline: value.text});
          }
        } catch (error) {
          receipts.unshift(...settled.slice(i));
          for (const remaining of updates) pending.set(remaining.context, pending.get(remaining.context) ?? remaining);
          throw error;
        }
      }
      for (let i = 0; i < updates.length; i++) {
        const value = updates[i]!, update = {...value, baseline: effectiveBaseline(value.context, value.baseline)};
        try {await options.drafts.save(update);} catch (error) {
          for (const remaining of updates.slice(i)) pending.set(remaining.context, pending.get(remaining.context) ?? remaining);
          throw error;
        }
      }
      await options.drafts.checkpoint();
    });
    operations = task.then(() => {failure = false;}, () => {failure = true;}).then(() => render());
    return task;
  }
  function schedule() {clearTimer(); timer = setTimeout(() => {timer = null; void flush().catch(() => {});}, 200);}
  const onInput = () => {if (stopped) return; edited = true; capture(); schedule();};
  function bind() {
    input?.addEventListener('input', onInput);
    const generation = lifecycle;
    removeContext = options.subscribeContext(() => {if (!stopped && generation === lifecycle) {edited = false; void render();}});
    removeApplied = options.subscribeApplied(value => {
      if (stopped || generation !== lifecycle) return;
      applied.push({...value}); if (applied.length > 64) applied.shift();
      receipts.push({...value}); if (receipts.length > 64) receipts.shift();
      capture(); void flush().catch(() => {});
    });
  }
  async function prepareForRestart(): Promise<void> {
    capture(); await flush(); await operations;
    if (pending.size || failure) throw new Error('Script drafts could not be stored. Keep this window open.');
  }
  async function readyForRuntimeRecovery(): Promise<boolean> {
    await operations; await render();
    return !failure && (!options.drafts || !!input && await options.drafts.readyForRuntimeRecovery());
  }
  function stop() {
    if (stopped) return;
    capture(); clearTimer(); void flush().catch(() => {}); stopped = true; lifecycle++; renderVersion++; panel.hidden = true;
    input?.removeEventListener('input', onInput); removeContext?.(); removeApplied?.(); removeContext = removeApplied = null;
  }
  function resume() {if (!stopped) return; stopped = false; lifecycle++; working = false; bind(); void render();}
  bind(); void render();
  return {prepareForRestart, readyForRuntimeRecovery, stop, resume};
}
