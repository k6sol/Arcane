import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { types } from 'node:util';
import { ArcaneError } from '../../protocol/src/providers.js';

export interface NativeConversation {
  provider: 'codex' | 'claude-code';
  threadId: string;
  sessionId: string | null;
}
export type ConversationWorkKind = 'workflow' | 'asset-job';
export interface ConversationWorkBinding {
  projectId: string;
  conversation: NativeConversation;
  kind: ConversationWorkKind;
  id: string;
}
export interface ConversationWorkPagination { limit?: number; after?: string }
export interface ConversationWorkPage { items: ConversationWorkBinding[]; nextCursor: string | null }
export const CONVERSATION_WORK_LIMITS = Object.freeze({
  workId: 64, nativeId: 256, pageItems: 100, pageBytes: 512 * 1024,
  bindings: 4096, recordBytes: 2048, totalBytes: 8 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
});

type Row = Record<string, unknown>;
const PREFIX = 'CONVERSATION_WORK_';
const APPLICATION_ID = 0x41524357; // Arcane conversation work (ARCW).
const VERSION = 1;
const HASH = /^[a-f0-9]{64}$/;
const TABLES = [
  'CREATE TABLE conversation_work_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1),project_id TEXT NOT NULL,project_path TEXT NOT NULL) STRICT',
  "CREATE TABLE conversation_work_bindings (sequence INTEGER PRIMARY KEY CHECK(sequence>0),kind TEXT NOT NULL CHECK(kind IN ('workflow','asset-job')),work_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code')),thread_id TEXT NOT NULL,session_id TEXT,UNIQUE(kind,work_id)) STRICT",
  'CREATE INDEX conversation_work_by_native ON conversation_work_bindings(provider,thread_id,session_id,sequence)',
];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const projectHash = (path: string) => hash(process.platform === 'win32' ? path.toLowerCase() : path);
function fail(code: string, message: string): never { throw new ArcaneError(PREFIX + code, message); }

/** Read data descriptors only: accessors, symbols, inherited fields and custom prototypes are rejected. */
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail('INPUT', 'Expected a plain metadata object.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT', 'Expected own metadata fields.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) fail('INPUT', 'Too many metadata fields.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
      required.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT', 'Unexpected or missing metadata fields.');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INPUT', 'Metadata accessors are forbidden.');
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function kind(value: unknown): ConversationWorkKind {
  if (value !== 'workflow' && value !== 'asset-job') fail('INPUT', 'Expected a supported work namespace.');
  return value;
}
function workId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail('INPUT', 'Expected a bounded work identifier.');
  return value;
}
function nativeId(value: unknown): string {
  // Match existing native-history opaque ID syntax, without importing or reading native history.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ||
      /\b(?:sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|arcane_local_v\d+_\d+_[a-f0-9]{64})\b/i.test(value) ||
      /\b[a-f0-9]{64}\b/i.test(value) || /\b(?:password|passwd|token|secret|api[_-]?key|authorization|cookie|credentials):/i.test(value) || /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    fail('INPUT', 'Expected a bounded opaque native identifier, without credential content.');
  }
  return value;
}
function conversation(value: unknown): NativeConversation {
  const a = fields(value, ['provider', 'threadId', 'sessionId']);
  if (a.provider !== 'codex' && a.provider !== 'claude-code') fail('INPUT', 'Expected a supported native provider.');
  return { provider: a.provider, threadId: nativeId(a.threadId), sessionId: a.sessionId === null ? null : nativeId(a.sessionId) };
}
function directPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || Buffer.byteLength(value) > 4096 ||
      !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) {
    fail('PATH', 'Use a bounded absolute local project or Arcane state path.');
  }
  const root = parse(value).root;
  const parts = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  const privateParts = ['.git', '.codex', '.claude', '.agents', '.aws', '.azure', '.ssh', '.gnupg'];
  if (parts.some(part => part === '.' || part === '..' || privateParts.includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part)) ||
      (process.platform === 'win32' && (!/^[a-z]:[\\/]$/i.test(root) || parts.some(part => /[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    fail('PATH', 'Traversal, ambiguous paths and private provider/config directories are forbidden.');
  }
  const result = resolve(value);
  if (result === parse(result).root) fail('PATH', 'Filesystem roots are not project or state directories.');
  return result;
}
function noLinks(path: string, missing = false): void {
  let current = path;
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(current), current)) fail('PATH', 'Project and state directories must be direct directories.');
    } catch (error) {
      if (error instanceof ArcaneError) throw error;
      if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') fail('PATH', 'Project or state directory cannot be safely inspected.');
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
const equalConversation = (a: NativeConversation, b: NativeConversation) =>
  a.provider === b.provider && a.threadId === b.threadId && a.sessionId === b.sessionId;
// Bound persisted metadata before materializing any rows in JavaScript.
const RECORD_SIZE = 'length(CAST(kind AS BLOB))+length(CAST(work_id AS BLOB))+length(CAST(provider AS BLOB))+length(CAST(thread_id AS BLOB))+coalesce(length(CAST(session_id AS BLOB)),0)';

/** Host-only association metadata. Never creates, resumes or reads a native conversation or work item.
 * Separate work databases cannot participate in this store's transaction; ambiguous host outcomes
 * require observation/reconciliation, never automatic work recreation or inferred attribution.
 * Path checks are cooperative safeguards, not an OS sandbox against racing local processes.
 */
export class ConversationWorkStore {
  #db!: DatabaseSync;
  #closed = false;
  readonly #projectId: string;
  readonly #projectPath: string;
  readonly #directory: string;
  readonly #databasePath: string;
  #fileIdentity: { dev: number; ino: number } | undefined;

  get projectId(): string { return this.#projectId; }
  get projectPath(): string { return this.#projectPath; }

  constructor(options: { directory: string; projectPath: string }) {
    const a = fields(options, ['directory', 'projectPath']);
    const selected = directPath(a.projectPath);
    noLinks(selected);
    this.#projectPath = realpathSync(selected);
    this.#projectId = projectHash(this.#projectPath);
    this.#directory = directPath(a.directory);
    this.#databasePath = join(this.#directory, 'conversation-work.sqlite');
    try {
      noLinks(this.#directory, true);
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      this.#checkPaths(false);
      // Exclusively create an Arcane-owned file with private POSIX mode. Existing files are inspected.
      try { const fd = openSync(this.#databasePath, 'wx', 0o600); closeSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      this.#checkPaths();
      const stat = lstatSync(this.#databasePath);
      this.#fileIdentity = { dev: stat.dev, ino: stat.ino };
      this.#db = new DatabaseSync(this.#databasePath, { timeout: 2000, allowExtension: false });
      this.#db.exec('PRAGMA trusted_schema=OFF;');
      this.#transaction(true, () => {
        const version = this.#version();
        if (version > VERSION) fail('MIGRATION', 'Conversation work schema is newer than this build.');
        if (version !== 0 && version !== VERSION) fail('CORRUPT', 'Invalid conversation work schema version.');
        if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('CORRUPT', 'Conversation work database failed integrity checks.');
        if (version === 0) {
          if (this.#db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() ||
              this.#db.prepare('PRAGMA application_id').get()?.application_id !== 0) fail('CORRUPT', 'Unversioned database is not an empty Arcane association store.');
          for (const ddl of TABLES) this.#db.exec(ddl);
          this.#db.prepare('INSERT INTO conversation_work_meta VALUES(1,?,?)').run(this.#projectId, this.#projectPath);
          this.#db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};`);
        }
        this.#validate();
      });
      const pageSize = Number(this.#db.prepare('PRAGMA page_size').get()?.page_size);
      if (!Number.isSafeInteger(pageSize) || pageSize < 512) fail('CORRUPT', 'Invalid SQLite page size.');
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=${CONVERSATION_WORK_LIMITS.fileBytes}; PRAGMA max_page_count=${Math.floor(CONVERSATION_WORK_LIMITS.fileBytes / pageSize)};`);
      this.#checkPaths();
    } catch (error) {
      try { this.#db?.close(); } catch { /* Preserve the failure. */ }
      this.#error(error);
    }
  }

  #error(error: unknown): never {
    if (error instanceof ArcaneError) throw error;
    fail('CORRUPT', 'Conversation work storage could not be accessed or validated; no repair was attempted.');
  }
  #checkPaths(requireDatabase = true): void {
    noLinks(this.#projectPath);
    noLinks(this.#directory);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = this.#databasePath + suffix;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(realpathSync(file), file)) fail('PATH', 'SQLite files must be direct single-link regular files.');
        if (stat.size > CONVERSATION_WORK_LIMITS.fileBytes) fail('CAPACITY', 'SQLite file exceeds the storage size bound.');
        if (!suffix && this.#fileIdentity && (stat.dev !== this.#fileIdentity.dev || stat.ino !== this.#fileIdentity.ino)) fail('PATH', 'The open SQLite file was replaced.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!suffix && requireDatabase) fail('PATH', 'The SQLite file is missing.');
      }
    }
  }
  #transaction<T>(write: boolean, work: () => T): T {
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve an unknown commit outcome. */ }
      throw error;
    }
  }
  #access<T>(write: boolean, work: () => T): T {
    if (this.#closed) fail('CLOSED', 'Conversation work storage is closed.');
    try {
      this.#checkPaths();
      const result = this.#transaction(write, () => {
        this.#validate();
        const result = work();
        this.#checkPaths();
        return result;
      });
      // A post-commit failure is an unknown caller outcome, never permission to recreate work.
      this.#checkPaths();
      return result;
    } catch (error) { return this.#error(error); }
  }
  #version(): number { return Number(this.#db.prepare('PRAGMA user_version').get()?.user_version); }
  #validate(): void {
    if (this.#version() !== VERSION) fail('MIGRATION', 'Conversation work schema changed; close and inspect storage.');
    if (this.#db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) fail('CORRUPT', 'SQLite application identity changed.');
    const schemaSize = this.#db.prepare("SELECT count(*) AS n,coalesce(max(length(CAST(sql AS BLOB))),0) AS largest FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() as Row;
    if (schemaSize.n !== TABLES.length || Number(schemaSize.largest) > CONVERSATION_WORK_LIMITS.recordBytes) fail('CORRUPT', 'Conversation work schema exceeds its bounds.');
    const schema = this.#db.prepare("SELECT type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
    if (schema.length !== TABLES.length || schema.some(row => !TABLES.includes(row.sql as string) || !['table', 'index'].includes(row.type as string))) fail('CORRUPT', 'Conversation work schema does not match this version.');
    const metaSize = this.#db.prepare('SELECT count(*) AS n,coalesce(max(length(CAST(project_id AS BLOB))),0) AS id_bytes,coalesce(max(length(CAST(project_path AS BLOB))),0) AS path_bytes FROM conversation_work_meta').get() as Row;
    if (metaSize.n !== 1 || Number(metaSize.id_bytes) !== 64 || Number(metaSize.path_bytes) > 4096) fail('CORRUPT', 'Project metadata exceeds its bounds.');
    const meta = this.#db.prepare('SELECT * FROM conversation_work_meta').get() as Row;
    if (meta.singleton !== 1 || typeof meta.project_id !== 'string' || !HASH.test(meta.project_id) || typeof meta.project_path !== 'string' || projectHash(meta.project_path) !== meta.project_id) fail('CORRUPT', 'Project metadata is invalid.');
    if (meta.project_id !== this.#projectId || !samePath(meta.project_path, this.#projectPath)) fail('PROJECT', 'Conversation work storage belongs to another canonical project.');
    const sizes = this.#db.prepare(`SELECT count(*) AS n,coalesce(sum(${RECORD_SIZE}),0) AS total,coalesce(max(${RECORD_SIZE}),0) AS largest FROM conversation_work_bindings`).get() as Row;
    if (Number(sizes.n) > CONVERSATION_WORK_LIMITS.bindings || Number(sizes.total) > CONVERSATION_WORK_LIMITS.totalBytes || Number(sizes.largest) > CONVERSATION_WORK_LIMITS.recordBytes) fail('CORRUPT', 'Stored association metadata exceeds its bounds.');
    for (const row of this.#db.prepare('SELECT * FROM conversation_work_bindings').iterate()) this.#decode(row as Row);
  }
  #decode(row: Row): ConversationWorkBinding {
    try {
      if (!Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1) throw new Error();
      return { projectId: this.#projectId, kind: kind(row.kind), id: workId(row.work_id),
        conversation: conversation({ provider: row.provider, threadId: row.thread_id, sessionId: row.session_id }) };
    } catch { return fail('CORRUPT', 'Stored association metadata is invalid.'); }
  }
  #binding(kind: ConversationWorkKind, id: string): ConversationWorkBinding | null {
    const row = this.#db.prepare('SELECT * FROM conversation_work_bindings WHERE kind=? AND work_id=?').get(kind, id);
    return row ? this.#decode(row as Row) : null;
  }

  bind(input: { conversation: NativeConversation; kind: ConversationWorkKind; id: string }): ConversationWorkBinding {
    const a = fields(input, ['conversation', 'kind', 'id']);
    const native = conversation(a.conversation), namespace = kind(a.kind), id = workId(a.id);
    return this.#access(true, () => {
      const previous = this.#binding(namespace, id);
      if (previous) {
        if (!equalConversation(previous.conversation, native)) fail('CONFLICT', 'Work identity already belongs to another exact native conversation.');
        return previous;
      }
      const sizes = this.#db.prepare(`SELECT count(*) AS n,coalesce(sum(${RECORD_SIZE}),0) AS total,coalesce(max(sequence),0) AS last FROM conversation_work_bindings`).get() as Row;
      const bytes = Buffer.byteLength(namespace + id + native.provider + native.threadId + (native.sessionId ?? ''));
      if (Number(sizes.n) >= CONVERSATION_WORK_LIMITS.bindings || bytes > CONVERSATION_WORK_LIMITS.recordBytes ||
          Number(sizes.total) + bytes > CONVERSATION_WORK_LIMITS.totalBytes || Number(sizes.last) >= Number.MAX_SAFE_INTEGER) fail('CAPACITY', 'Association capacity exceeded; no association was written.');
      this.#db.prepare('INSERT INTO conversation_work_bindings(sequence,kind,work_id,provider,thread_id,session_id) VALUES(?,?,?,?,?,?)')
        .run(Number(sizes.last) + 1, namespace, id, native.provider, native.threadId, native.sessionId);
      return { projectId: this.#projectId, conversation: native, kind: namespace, id };
    });
  }
  binding(workKind: ConversationWorkKind, id: string): ConversationWorkBinding | null {
    const namespace = kind(workKind), identity = workId(id);
    return this.#access(false, () => this.#binding(namespace, identity));
  }
  list(nativeConversation: NativeConversation, workKind?: ConversationWorkKind, pagination?: ConversationWorkPagination): ConversationWorkPage {
    const native = conversation(nativeConversation), namespace = workKind === undefined ? undefined : kind(workKind);
    const page = pagination === undefined ? {} : fields(pagination, [], ['limit', 'after']);
    const limit = Object.hasOwn(page, 'limit') ? page.limit : CONVERSATION_WORK_LIMITS.pageItems;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_WORK_LIMITS.pageItems) fail('INPUT', 'Page size must be an integer from 1 to 100.');
    const scope = hash(JSON.stringify([this.#projectId, native.provider, native.threadId, native.sessionId, namespace ?? null]));
    let after = 0;
    if (Object.hasOwn(page, 'after')) {
      if (typeof page.after !== 'string' || !/^[a-f0-9]{64}:[1-9][0-9]{0,15}$/.test(page.after) || page.after.slice(0, 64) !== scope) fail('INPUT', 'Invalid cursor for this exact conversation and namespace.');
      after = Number(page.after.slice(65));
      if (!Number.isSafeInteger(after)) fail('INPUT', 'Pagination cursor exceeds its bounds.');
    }
    return this.#access(false, () => {
      const filter = 'provider=? AND thread_id=? AND session_id IS ?' + (namespace === undefined ? '' : ' AND kind=?');
      const args = namespace === undefined ? [native.provider, native.threadId, native.sessionId] : [native.provider, native.threadId, native.sessionId, namespace];
      if (after && !this.#db.prepare(`SELECT 1 FROM conversation_work_bindings WHERE ${filter} AND sequence=?`).get(...args, after)) fail('INPUT', 'Cursor does not name an association in this conversation.');
      const rows = this.#db.prepare(`SELECT * FROM conversation_work_bindings WHERE ${filter} AND sequence>? ORDER BY sequence LIMIT ?`).all(...args, after, limit + 1) as Row[];
      const items = rows.slice(0, limit).map(row => this.#decode(row));
      const nextCursor = rows.length > limit ? `${scope}:${rows[limit - 1]!.sequence as number}` : null;
      const result = { items, nextCursor };
      if (Buffer.byteLength(JSON.stringify(result)) > CONVERSATION_WORK_LIMITS.pageBytes) fail('CAPACITY', 'Association page exceeds the byte bound.');
      return result;
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
