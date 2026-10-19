/// <reference lib="dom" />
export type EditorDraftKind = 'project-memory' | 'script-source';
export interface EditorDraft { id: string; kind: EditorDraftKind; title: string; context: string; baseline: string | null; text: string }
export type EditorDraftInput = Omit<EditorDraft, 'id'>;
export interface EditorDraftSnapshot {version: 1; projectPath: string; drafts: EditorDraft[]}
export interface EditorDraftBridge {version: 1; read(): Promise<unknown>; save(value: EditorDraftSnapshot): Promise<unknown>}
const MESSAGE = 'Editor drafts could not be stored. Keep this window open and try again.';
const fail = (): never => { throw new Error(MESSAGE); };
const fields = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const d = Object.getOwnPropertyDescriptor(value, key); return !d?.enumerable || !Object.hasOwn(d, 'value');
      })) return fail();
  return value as Record<string, unknown>;
};
const text = (value: unknown, limit: number, identifier = false): string => {
  if (typeof value !== 'string') return fail();
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > limit || new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes) !== value ||
      identifier && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return fail();
  return value;
};
function draft(value: unknown): EditorDraft {
  const row = fields(value, ['id', 'kind', 'title', 'context', 'baseline', 'text']);
  if (row.kind !== 'project-memory' && row.kind !== 'script-source') return fail();
  const id = text(row.id, 128, true), title = text(row.title, 512), context = text(row.context, 4096);
  if (!context || /[\x00-\x1f\x7f]/.test(title) || row.kind === 'project-memory' && context !== 'project-memory') return fail();
  const limit = row.kind === 'project-memory' ? 16 * 1024 : 100 * 1024;
  return {id, kind: row.kind, title, context, baseline: row.baseline === null ? null : text(row.baseline, limit), text: text(row.text, limit)};
}
const key = (value: Pick<EditorDraft, 'kind' | 'context'>) => value.kind + '\0' + value.context;
export function readEditorDraftSnapshot(value: unknown): EditorDraftSnapshot {
  const row = fields(value, ['version', 'projectPath', 'drafts']);
  const projectPath = text(row.projectPath, 4096);
  if (row.version !== 1 || !projectPath || !Array.isArray(row.drafts) || Object.getPrototypeOf(row.drafts) !== Array.prototype ||
      row.drafts.length > 16 || Reflect.ownKeys(row.drafts).length !== row.drafts.length + 1) return fail();
  const drafts: EditorDraft[] = [], ids = new Set<string>(), contexts = new Set<string>();
  for (let i = 0; i < row.drafts.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(row.drafts, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
    const item = draft(descriptor.value);
    if (ids.has(item.id) || contexts.has(key(item))) return fail();
    ids.add(item.id); contexts.add(key(item)); drafts.push(item);
  }
  const result: EditorDraftSnapshot = {version: 1, projectPath, drafts};
  if (new TextEncoder().encode(JSON.stringify(result)).length > 511 * 1024) return fail();
  return result;
}

/** Presentation state only. Queued writes never invoke file saves, tools, model turns or browser storage. */
export class EditorDraftStore {
  private readonly initial: Promise<void>;
  private operations: Promise<void> = Promise.resolve();
  private rows = new Map<string, EditorDraft>();
  private projectPath: string | null = null;
  private available = false;
  private loadError = false;
  private dirty = false;
  private failure = false;
  constructor(private readonly bridge: EditorDraftBridge) {
    this.initial = this.hydrate().catch(() => { this.loadError = true; });
  }
  private async hydrate(): Promise<void> {
    const reply = fields(await this.bridge.read(), ['available', 'projectPath', 'preferences']);
    if (typeof reply.available !== 'boolean') fail();
    if (!reply.available) { if (reply.projectPath !== null || reply.preferences !== null) fail(); return; }
    const projectPath = text(reply.projectPath, 4096); if (!projectPath) fail();
    const snapshot = reply.preferences === null ? null : readEditorDraftSnapshot(reply.preferences);
    if (snapshot && snapshot.projectPath !== projectPath) fail();
    this.projectPath = projectPath; this.available = true;
    for (const item of snapshot?.drafts ?? []) this.rows.set(key(item), item);
  }
  private async usable(): Promise<void> {
    await this.initial;
    if (this.loadError || !this.available || !this.projectPath) fail();
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.operations.then(action);
    this.operations = next.then(() => { this.failure = false; }, () => { this.failure = true; });
    return next;
  }
  private async persist(): Promise<void> {
    await this.usable();
    const snapshot = readEditorDraftSnapshot({version: 1, projectPath: this.projectPath, drafts: [...this.rows.values()]});
    const reply = fields(await this.bridge.save(snapshot), ['saved']);
    if (reply.saved !== true) fail();
    this.dirty = false;
  }
  async get(kind: EditorDraftKind, context: string): Promise<EditorDraft | null> {
    await this.initial; await this.operations; if (this.loadError) fail();
    const item = this.rows.get(key({kind, context})); return item ? {...item} : null;
  }
  async list(kind?: EditorDraftKind): Promise<EditorDraft[]> {
    await this.initial; await this.operations; if (this.loadError) fail();
    return [...this.rows.values()].filter(item => !kind || item.kind === kind).map(item => ({...item}));
  }
  async save(value: EditorDraftInput): Promise<void> {
    const captured = draft({...value, id: 'draft:' + crypto.randomUUID()});
    return this.enqueue(async () => {
      await this.usable(); const itemKey = key(captured), previous = this.rows.get(itemKey);
      if (captured.text === captured.baseline) {
        if (!previous) return; this.rows.delete(itemKey);
      } else {
        const item = {...captured, id: previous?.id ?? captured.id};
        if (previous && JSON.stringify(previous) === JSON.stringify(item) && !this.dirty) return;
        this.rows.set(itemKey, item);
      }
      this.dirty = true; await this.persist();
    });
  }
  async discard(value: EditorDraft): Promise<void> {
    const captured = draft(value);
    return this.enqueue(async () => {
      await this.usable(); const itemKey = key(captured), current = this.rows.get(itemKey);
      if (!current || JSON.stringify(current) !== JSON.stringify(captured)) return;
      this.rows.delete(itemKey); this.dirty = true; await this.persist();
    });
  }
  checkpoint(): Promise<void> {
    return this.enqueue(async () => { await this.usable(); if (this.dirty) await this.persist(); });
  }
  async readyForRuntimeRecovery(): Promise<boolean> {
    await this.initial; await this.operations;
    return this.available && !this.loadError && !this.dirty && !this.failure;
  }
}
