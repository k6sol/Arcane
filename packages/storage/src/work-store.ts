import { DatabaseSync } from 'node:sqlite';
import { sqliteTransportPath } from './sqlite-path.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual, types } from 'node:util';
import { z } from 'zod';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ArcaneError } from '../../protocol/src/providers.js';
import { object, textField } from '../../protocol/src/studio.js';

export type TaskState = 'pending' | 'in_progress' | 'needs_review' | 'complete' | 'failed' | 'interrupted';
export interface Evidence { path: string; sha256: string; bytes: number; note: string; addedAt: string }
export interface WorkTask {
  id: string; key: string; runId: string; title: string; instructions: string; acceptance: string;
  dependencies: string[]; scope: string[]; state: TaskState; worker: string | null;
  leaseUntil: string | null; progress: string; evidence: Evidence[]; reviewNote: string | null;
  createdAt: string; updatedAt: string;
}
export interface WorkRun { id: string; title: string; objective: string; createdAt: string; tasks: WorkTask[] }
type Row = Record<string, string | number | null>;
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const WORK_VERSION = 2, ROW_BYTES = 4 * 1024 * 1024;
const RUNS_SQL = 'CREATE TABLE runs (id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT';
const TASKS_SQL = 'CREATE TABLE tasks (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL,lease_hash TEXT) STRICT';
const BINDINGS_SQL = 'CREATE TABLE task_bindings(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,binding_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192)) STRICT';
export const EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const TASK_BINDING_LIMITS = Object.freeze({ bindings: 256, payloadBytes: 8192 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HEX64 = /^[a-f0-9]{64}$/;
const idText = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const safeStoredPath = z.string().min(1).max(300).refine(p => !isAbsolute(p) && !/^[a-z]:/i.test(p) &&
  p.split('/').every(s => !!s && s !== '..' && s !== '.' && !/[<>:"|?*\\\x00-\x1f]/.test(s) &&
    !['.git', '.codex', '.agents', '.aws', 'node_modules', '.env'].includes(s.toLowerCase()) && !s.toLowerCase().startsWith('.env.')));
const storedRun = z.strictObject({ id: z.string().uuid(), title: z.string().min(1).max(200), objective: z.string().min(1).max(8000), createdAt: z.string().datetime() });
const storedTask = z.strictObject({ id: z.string().uuid(), key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), runId: z.string().uuid(),
  title: z.string().min(1).max(200), instructions: z.string().min(1).max(16000), acceptance: z.string().min(1).max(4000),
  dependencies: z.array(z.string().min(1).max(64)).max(64), scope: z.array(safeStoredPath).min(1).max(20),
  state: z.enum(['pending', 'in_progress', 'needs_review', 'complete', 'failed', 'interrupted']), worker: z.string().min(1).max(200).nullable(),
  leaseUntil: z.string().datetime().nullable(), progress: z.string().max(ROW_BYTES),
  evidence: z.array(z.strictObject({ path: safeStoredPath, sha256: z.string().regex(HEX64), bytes: z.number().int().min(0).max(EVIDENCE_MAX_BYTES),
    note: z.string().min(1).max(2000), addedAt: z.string().datetime() })).max(20), reviewNote: z.string().min(1).max(4000).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).refine(t => t.state !== 'in_progress' || t.worker !== null && t.leaseUntil !== null);
/** Original native identity captured by trusted host code: provenance data, never authority. */
export interface WorkTaskOriginal {
  readonly accountIdentity: string; readonly connectionId: string; readonly incarnationId: string; readonly threadId: string; readonly sessionId: string | null;
  readonly model: string; readonly effort: string; readonly allowWorkspaceWrites: boolean; readonly allowAssets: boolean;
}
export interface WorkTaskBinding {
  readonly id: string; readonly runId: string; readonly taskId: string; readonly planId: string; readonly objectiveSha256: string; readonly runInputSha256: string;
  readonly projectPath: string; readonly projectId: string; readonly original: WorkTaskOriginal; readonly createdAt: string;
}
const bindingKey = (taskId: string, planId: string) => hash(JSON.stringify(['arcane-task-binding-v1', taskId, planId]));
/** Detached bounded plain data: proxies are refused before any trap can run; accessors, symbols, exotic prototypes refused. */
export function detachPlain(value: unknown, budget = { nodes: 4096 }, depth = 0): unknown {
  if (--budget.nodes < 0 || depth > 6) throw new ArcaneError('INPUT', 'Input exceeds its structural bound.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new ArcaneError('INPUT', 'Numbers must be finite.'); return value; }
  if (typeof value !== 'object' || types.isProxy(value)) throw new ArcaneError('INPUT', 'Input must be plain data.');
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 256 || keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string' || key !== 'length' && String(Number(key)) !== key)) throw new ArcaneError('INPUT', 'Arrays must be plain bounded data.');
    return Array.from({ length: value.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(value, index);
      if (!field || !Object.hasOwn(field, 'value')) throw new ArcaneError('INPUT', 'Array items must be plain data.');
      return detachPlain(field.value, budget, depth + 1);
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || keys.length > 64) throw new ArcaneError('INPUT', 'Objects must be plain bounded data.');
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) throw new ArcaneError('INPUT', 'Object fields must be plain string-keyed data.');
    Object.defineProperty(out, key, { value: detachPlain(field.value, budget, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Direct, single-link, bounded regular file read with descriptor identity checked before and after;
 * the cap is enforced before allocation and during the read. Cooperative checks, not an OS sandbox. */
function verifyDirectFile(full: string): { sha256: string; bytes: number } {
  const before = lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > EVIDENCE_MAX_BYTES) throw new ArcaneError('EVIDENCE', 'Evidence must be a direct single-link file <=16 MiB.');
  const fd = openSync(full, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new ArcaneError('EVIDENCE', 'Evidence changed while opening.');
    const buffer = Buffer.alloc(Math.min(before.size, EVIDENCE_MAX_BYTES) + 1); let length = 0;
    for (;;) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; if (length > EVIDENCE_MAX_BYTES || length > before.size) throw new ArcaneError('EVIDENCE', 'Evidence grew while reading.'); }
    const after = fstatSync(fd), named = lstatSync(full);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1 || !after.isFile() ||
        named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size || named.mtimeMs !== before.mtimeMs || named.nlink !== 1 || !named.isFile() || named.isSymbolicLink())
      throw new ArcaneError('EVIDENCE', 'Evidence changed while reading.');
    return { sha256: hash(buffer.subarray(0, length)), bytes: length };
  } finally { closeSync(fd); }
}

/** Cooperative workflow leases, NOT an OS sandbox for agents/native tools. */
export class WorkStore {
  private db: DatabaseSync;
  private project: string;
  private now: () => number;
  /** Physical project captured by this store, for trusted host composition checks. */
  get projectPath(): string { return this.project; }
  constructor(options: { directory: string; projectPath: string; now?: () => number }) {
    mkdirSync(options.directory, { recursive: true }); this.project = realpathSync(options.projectPath); this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(sqliteTransportPath(join(options.directory, 'work.sqlite')), { timeout: 2000, allowExtension: false });
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > WORK_VERSION) { this.db.close(); throw new ArcaneError('MIGRATION', 'Work database is newer than this build.'); }
    try {
      if (!Number.isSafeInteger(version) || version < 0) throw new ArcaneError('CORRUPT', 'Work database version is invalid.');
      if (version === 0) {
        // Only an empty file may be initialized; any pre-existing object is foreign state.
        if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new ArcaneError('CORRUPT', 'Unversioned work database is not empty.');
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        this.transaction(() => { this.db.exec(RUNS_SQL); this.db.exec(TASKS_SQL); this.db.exec(BINDINGS_SQL); this.db.exec('PRAGMA user_version=' + WORK_VERSION); });
      } else {
        // Exact schema and every row validated read-only BEFORE the WAL switch or any migration write.
        this.validateStored(version);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        if (version === 1) this.transaction(() => {
          if (Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version) !== 1) throw new ArcaneError('CORRUPT', 'Work database version changed during migration.');
          this.validateStored(1); this.db.exec(BINDINGS_SQL); this.db.exec('PRAGMA user_version=' + WORK_VERSION);
        });
        this.validateStored(WORK_VERSION);
      }
    } catch (error) { this.db.close(); throw error; }
    // Native worker handles do not survive a daemon restart. Preserve work/evidence for review.
    for (const task of this.allTasks()) if (task.state === 'in_progress') { task.state = 'interrupted'; task.leaseUntil = null; task.progress = 'Daemon restarted. Inspect artifacts before reclaiming.'; this.save(task, null); }
  }
  /** Exact schema plus bounded, identity-checked rows. Historical v1 runs are never labelled as bound. */
  private validateStored(version: number): void {
    const expected = version === 1 ? [RUNS_SQL, TASKS_SQL] : [RUNS_SQL, TASKS_SQL, BINDINGS_SQL];
    const objects = this.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
    if (objects.length !== expected.length || objects.some(row => row.type !== 'table' || !expected.includes(String(row.sql)))) throw new ArcaneError('CORRUPT', 'Work database schema changed.');
    const runIds = new Set<string>();
    for (const row of this.db.prepare('SELECT id,payload FROM runs').all() as Row[]) {
      this.runRow(row); runIds.add(String(row.id));
    }
    for (const row of this.db.prepare('SELECT id,run_id,payload FROM tasks').all() as Row[]) {
      this.taskRow(row);
      if (!runIds.has(String(row.run_id))) throw new ArcaneError('CORRUPT', 'Work task row is corrupt.');
    }
    for (const runId of runIds) this.runById(runId);
    if (version >= 2) {
      const rows = this.db.prepare('SELECT id,run_id,binding_key,payload FROM task_bindings LIMIT ?').all(TASK_BINDING_LIMITS.bindings + 1) as Row[];
      if (rows.length > TASK_BINDING_LIMITS.bindings) throw new ArcaneError('CORRUPT', 'Task binding retention exceeded.');
      for (const row of rows) { const binding = this.bindingRow(row); if (!runIds.has(binding.runId)) throw new ArcaneError('CORRUPT', 'Task binding names a missing run.'); this.boundRun(binding); }
    }
  }
  /** Bounded BEFORE JSON.parse; a plain object is required. */
  private rowObject(row: Row): unknown {
    if (typeof row.id !== 'string' || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > ROW_BYTES) throw new ArcaneError('CORRUPT', 'Work row exceeds its bound or is corrupt.');
    let value: unknown; try { value = JSON.parse(row.payload); } catch { throw new ArcaneError('CORRUPT', 'Work row is corrupt.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArcaneError('CORRUPT', 'Work row is corrupt.');
    return value;
  }
  private runRow(row: Row): Omit<WorkRun, 'tasks'> {
    const parsed = storedRun.safeParse(this.rowObject(row));
    if (!parsed.success || parsed.data.id !== row.id) throw new ArcaneError('CORRUPT', 'Work run row is corrupt.');
    return parsed.data;
  }
  private taskRow(row: Row): WorkTask {
    const parsed = storedTask.safeParse(this.rowObject(row));
    if (!parsed.success || parsed.data.id !== row.id || parsed.data.runId !== row.run_id) throw new ArcaneError('CORRUPT', 'Work task row is corrupt.');
    return parsed.data;
  }
  private boundRun(binding: WorkTaskBinding): WorkRun {
    const run = this.runById(binding.runId);
    if (this.runInputSha256(run) !== binding.runInputSha256) throw new ArcaneError('CORRUPT', 'Task binding run input changed.');
    return run;
  }
  private bindingRow(row: Row): WorkTaskBinding {
    if (typeof row.id !== 'string' || typeof row.run_id !== 'string' || typeof row.binding_key !== 'string' || typeof row.payload !== 'string' ||
      Buffer.byteLength(row.payload) > TASK_BINDING_LIMITS.payloadBytes) throw new ArcaneError('CORRUPT', 'Task binding is corrupt.');
    let b: Record<string, unknown>; try { b = JSON.parse(row.payload) as Record<string, unknown>; } catch { throw new ArcaneError('CORRUPT', 'Task binding is corrupt.'); }
    const o = b?.original as Record<string, unknown> | undefined;
    const keys = (value: object, list: string[]) => Object.keys(value).sort().join(',') === [...list].sort().join(',');
    if (!b || typeof b !== 'object' || !o || typeof o !== 'object' ||
      !keys(b, ['id','runId','taskId','planId','objectiveSha256','runInputSha256','projectPath','projectId','original','createdAt']) ||
      !keys(o, ['accountIdentity','connectionId','incarnationId','threadId','sessionId','model','effort','allowWorkspaceWrites','allowAssets']) ||
      b.id !== row.id || b.runId !== row.run_id || ![b.id, b.runId, b.taskId, b.planId].every(v => typeof v === 'string' && UUID.test(v)) ||
      ![b.objectiveSha256, b.runInputSha256, b.projectId, o.accountIdentity].every(v => typeof v === 'string' && HEX64.test(v)) ||
      row.binding_key !== bindingKey(b.taskId as string, b.planId as string) || typeof b.projectPath !== 'string' || !samePath(b.projectPath, this.project) ||
      b.projectId !== hash(process.platform === 'win32' ? this.project.toLowerCase() : this.project) ||
      typeof o.connectionId !== 'string' || !UUID.test(o.connectionId) || typeof o.incarnationId !== 'string' || !UUID.test(o.incarnationId) ||
      !idText(o.threadId) || !(o.sessionId === null || idText(o.sessionId)) || !idText(o.model) || !idText(o.effort) ||
      typeof o.allowWorkspaceWrites !== 'boolean' || typeof o.allowAssets !== 'boolean' || typeof b.createdAt !== 'string' || !Number.isFinite(Date.parse(b.createdAt)))
      throw new ArcaneError('CORRUPT', 'Task binding is corrupt or belongs to another project.');
    return Object.freeze({ ...b, original: Object.freeze({ ...o }) }) as unknown as WorkTaskBinding;
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const out = work(); this.db.exec('COMMIT'); return out; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private save(task: WorkTask, leaseHash?: string | null): void {
    task.updatedAt = this.iso();
    if (leaseHash !== undefined) this.db.prepare('UPDATE tasks SET payload=?,lease_hash=? WHERE id=?').run(JSON.stringify(task), leaseHash, task.id);
    else this.db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
  }
  private scoped(value: unknown): string {
    const p = textField(value, 'relative file scope', 300).replaceAll('\\', '/');
    if (isAbsolute(p) || /^[a-z]:/i.test(p) || p.split('/').some(s => !s || s === '..' || s === '.' || /[<>:"|?*\x00-\x1f]/.test(s)) || p.split('/').some(s => ['.git', '.codex', '.agents', '.aws', 'node_modules', '.env'].includes(s.toLowerCase()) || s.toLowerCase().startsWith('.env.'))) throw new ArcaneError('SCOPE', 'Scope must be a safe relative project path, not credential/config/metadata directories.');
    const full = resolve(this.project, p); let nearest = full;
    while (!existsSync(nearest)) nearest = dirname(nearest);
    const physical = realpathSync(nearest);
    if (physical !== this.project && !physical.startsWith(this.project + sep)) throw new ArcaneError('SCOPE', 'Scope follows a link outside the selected project.');
    return p;
  }
  create(input: unknown): WorkRun {
    const run = this.buildRun(input);
    this.transaction(() => this.insertRun(run));
    return run;
  }
  private insertRun(run: WorkRun): void {
    this.db.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(run.id, JSON.stringify({ id: run.id, title: run.title, objective: run.objective, createdAt: run.createdAt }));
    const stmt = this.db.prepare('INSERT INTO tasks(id,run_id,payload) VALUES(?,?,?)'); for (const task of run.tasks) stmt.run(task.id, run.id, JSON.stringify(task));
  }
  /** Canonical validated run input (no generated IDs or timestamps) used for duplicate binding comparison. */
  private runInputSha256(run: WorkRun): string {
    return hash(JSON.stringify([run.title, run.objective, run.tasks.map(t => [t.key, t.title, t.instructions, t.acceptance, t.scope, t.dependencies])]));
  }
  /** Trusted host-only: ONE original chat task + plan names ONE durable run, created atomically with its
   * binding. An identical repeat returns the original run (lost acknowledgement never allocates another);
   * any changed identity, objective, input or project refuses. Never exposed to browser/model/MCP input. */
  createForTask(input: unknown): { binding: WorkTaskBinding; run: WorkRun; replayed: boolean } {
    const a = detachPlain(input) as Record<string, unknown>;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).sort().join(',') !== 'objectiveSha256,original,planId,run,taskId') throw new ArcaneError('INPUT', 'Expected an exact task binding request.');
    const o = a.original as Record<string, unknown>;
    if (typeof a.taskId !== 'string' || !UUID.test(a.taskId) || typeof a.planId !== 'string' || !UUID.test(a.planId) || typeof a.objectiveSha256 !== 'string' || !HEX64.test(a.objectiveSha256) ||
      !o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join(',') !== 'accountIdentity,allowAssets,allowWorkspaceWrites,connectionId,effort,incarnationId,model,sessionId,threadId' ||
      typeof o.accountIdentity !== 'string' || !HEX64.test(o.accountIdentity) || typeof o.connectionId !== 'string' || !UUID.test(o.connectionId) ||
      typeof o.incarnationId !== 'string' || !UUID.test(o.incarnationId) || !idText(o.threadId) || !(o.sessionId === null || idText(o.sessionId)) ||
      !idText(o.model) || !idText(o.effort) || typeof o.allowWorkspaceWrites !== 'boolean' || typeof o.allowAssets !== 'boolean') throw new ArcaneError('INPUT', 'Invalid task binding identity.');
    const run = this.buildRun(a.run), runInputSha256 = this.runInputSha256(run), key = bindingKey(a.taskId, a.planId);
    const original = Object.freeze({ accountIdentity: o.accountIdentity, connectionId: o.connectionId, incarnationId: o.incarnationId, threadId: o.threadId, sessionId: o.sessionId,
      model: o.model, effort: o.effort, allowWorkspaceWrites: o.allowWorkspaceWrites, allowAssets: o.allowAssets }) as WorkTaskOriginal;
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,run_id,binding_key,payload FROM task_bindings WHERE binding_key=?').get(key) as Row | undefined;
      if (existing) {
        const binding = this.bindingRow(existing);
        if (binding.taskId !== a.taskId || binding.planId !== a.planId || binding.objectiveSha256 !== a.objectiveSha256 || binding.runInputSha256 !== runInputSha256 ||
          !isDeepStrictEqual(binding.original, original)) throw new ArcaneError('BINDING_CHANGED', 'This task plan is already bound to a different identity or run input.');
        return { binding, run: this.boundRun(binding), replayed: true };
      }
      if (Number((this.db.prepare('SELECT count(*) AS n FROM task_bindings').get() as Row).n) >= TASK_BINDING_LIMITS.bindings) throw new ArcaneError('BINDING_LIMIT', 'Task binding journal is full.');
      const binding: WorkTaskBinding = Object.freeze({ id: randomUUID(), runId: run.id, taskId: a.taskId as string, planId: a.planId as string, objectiveSha256: a.objectiveSha256 as string,
        runInputSha256, projectPath: this.project, projectId: hash(process.platform === 'win32' ? this.project.toLowerCase() : this.project), original, createdAt: this.iso() });
      const payload = JSON.stringify(binding);
      if (Buffer.byteLength(payload) > TASK_BINDING_LIMITS.payloadBytes) throw new ArcaneError('INPUT', 'Task binding exceeds its bound.');
      this.insertRun(run);
      this.db.prepare('INSERT INTO task_bindings(id,run_id,binding_key,payload) VALUES(?,?,?,?)').run(binding.id, run.id, key, payload);
      return { binding: this.bindingRow({ id: binding.id, run_id: run.id, binding_key: key, payload }), run, replayed: false };
    });
  }
  /** Exact lookup by original task + plan, independent of the runs() latest-100 display window. */
  bindingFor(taskId: string, planId: string): { binding: WorkTaskBinding; run: WorkRun } | null {
    if (typeof taskId !== 'string' || !UUID.test(taskId) || typeof planId !== 'string' || !UUID.test(planId)) throw new ArcaneError('INPUT', 'Invalid task binding lookup.');
    const row = this.db.prepare('SELECT id,run_id,binding_key,payload FROM task_bindings WHERE binding_key=?').get(bindingKey(taskId, planId)) as Row | undefined;
    if (!row) return null;
    const binding = this.bindingRow(row);
    if (binding.taskId !== taskId || binding.planId !== planId) throw new ArcaneError('CORRUPT', 'Task binding mapping is inconsistent.');
    return { binding, run: this.boundRun(binding) };
  }
  /** Exact bounded run read by ID. */
  runById(runId: string): WorkRun {
    if (typeof runId !== 'string' || !UUID.test(runId)) throw new ArcaneError('INPUT', 'Invalid run ID.');
    const row = this.db.prepare('SELECT id,payload FROM runs WHERE id=?').get(runId) as Row | undefined;
    if (!row) throw new ArcaneError('TASK', 'Unknown run.');
    const run = this.runRow(row);
    const tasks = (this.db.prepare('SELECT id,run_id,payload FROM tasks WHERE run_id=? ORDER BY rowid LIMIT 65').all(runId) as Row[]).map(r => {
      return this.taskRow(r); });
    if (!tasks.length || tasks.length > 64 || new Set(tasks.map(t => t.key)).size !== tasks.length) throw new ArcaneError('CORRUPT', 'Work run is corrupt.');
    const visited = new Set<string>(), active = new Set<string>();
    const visit = (key: string): void => { if (active.has(key)) throw new ArcaneError('CORRUPT', 'Work dependencies are corrupt.'); if (visited.has(key)) return;
      const task = tasks.find(t => t.key === key); if (!task) throw new ArcaneError('CORRUPT', 'Work dependency is missing.'); active.add(key);
      for (const dependency of task.dependencies) visit(dependency); active.delete(key); visited.add(key); };
    for (const task of tasks) visit(task.key);
    return { ...run, tasks };
  }
  /** Shared direct-file evidence verification for an exact in-project relative path. */
  verifyEvidence(path: unknown): { path: string; sha256: string; bytes: number } {
    const relativePath = this.scoped(path), direct = resolve(this.project, relativePath), full = realpathSync(direct);
    if (!samePath(full, direct) || full !== this.project && !full.startsWith(this.project + sep)) throw new ArcaneError('EVIDENCE', 'Evidence must be a direct in-project file.');
    const verified = verifyDirectFile(full);
    if (!samePath(realpathSync(direct), full)) throw new ArcaneError('EVIDENCE', 'Evidence path changed while reading.');
    return { path: relative(this.project, full).split(sep).join('/'), ...verified };
  }
  private buildRun(input: unknown): WorkRun {
    const a = object(input); const title = textField(a.title, 'run title', 200); const objective = textField(a.objective, 'objective', 8000);
    if (!Array.isArray(a.tasks) || a.tasks.length < 1 || a.tasks.length > 64) throw new ArcaneError('INPUT', 'A run needs 1..64 explicit tasks.');
    const runId = randomUUID(); const now = this.iso();
    const tasks = a.tasks.map(value => {
      const t = object(value); const key = textField(t.key, 'task key', 64);
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new ArcaneError('INPUT', 'Task key must be safe characters.');
      if (!Array.isArray(t.scope) || t.scope.length < 1 || t.scope.length > 20 || !Array.isArray(t.dependencies) || t.dependencies.length > 64) throw new ArcaneError('INPUT', 'Each task needs explicit scopes and dependencies.');
      const task: WorkTask = { id: randomUUID(), key, runId, title: textField(t.title, 'task title', 200), instructions: textField(t.instructions, 'task instructions', 16000), acceptance: textField(t.acceptance, 'acceptance criteria', 4000), scope: [...new Set(t.scope.map(s => this.scoped(s)))], dependencies: t.dependencies.map(d => textField(d, 'dependency', 64)), state: 'pending', worker: null, leaseUntil: null, progress: '', evidence: [], reviewNote: null, createdAt: now, updatedAt: now };
      return task;
    });
    const keys = new Set(tasks.map(t => t.key)); if (keys.size !== tasks.length) throw new ArcaneError('DEPENDENCY', 'Duplicate task keys.');
    const visited = new Set<string>(); const active = new Set<string>();
    const visit = (key: string) => { if (active.has(key)) throw new ArcaneError('DEPENDENCY', 'Task dependency cycle.'); if (visited.has(key)) return; active.add(key); const t = tasks.find(x => x.key === key)!; for (const d of t.dependencies) { if (!keys.has(d)) throw new ArcaneError('DEPENDENCY', 'Dependency names a missing task.'); visit(d); } active.delete(key); visited.add(key); };
    for (const task of tasks) visit(task.key);
    return { id: runId, title, objective, createdAt: now, tasks };
  }
  task(id: string): WorkTask { const r = this.db.prepare('SELECT id,run_id,payload FROM tasks WHERE id=?').get(id) as Row | undefined; if (!r) throw new ArcaneError('TASK', 'Unknown task.'); return this.taskRow(r); }
  private allTasks(): WorkTask[] { return (this.db.prepare('SELECT id,run_id,payload FROM tasks ORDER BY rowid').all() as Row[]).map(r => this.taskRow(r)); }
  runs(): WorkRun[] {
    this.expire(); const tasks = this.allTasks();
    return (this.db.prepare('SELECT id,payload FROM runs ORDER BY rowid DESC LIMIT 100').all() as Row[]).map(r => { const run = this.runRow(r); return { ...run, tasks: tasks.filter(t => t.runId === run.id) }; });
  }
  private expire(): void { for (const t of this.allTasks()) if (t.state === 'in_progress' && Date.parse(t.leaseUntil ?? '') <= this.now()) { t.state = 'interrupted'; t.leaseUntil = null; t.progress = 'Worker lease expired. Inspect changes before reclaiming; no automatic execution retry.'; this.save(t, null); } }
  ready(runId?: string): WorkTask[] {
    this.expire(); const all = this.allTasks(); return all.filter(t => (!runId || t.runId === runId) && ['pending', 'interrupted'].includes(t.state) && t.dependencies.every(d => all.some(x => x.runId === t.runId && x.key === d && x.state === 'complete')));
  }
  claim(input: unknown): { task: WorkTask; leaseToken: string } {
    const a = object(input); const taskId = textField(a.taskId, 'task ID'); const worker = textField(a.worker, 'worker label', 200);
    return this.transaction(() => {
      this.expire(); const t = this.task(taskId);
      if (!this.ready(t.runId).some(r => r.id === taskId)) throw new ArcaneError('TASK_STATE', 'Task is not ready, or dependencies have not passed review.');
      for (const path of t.scope) this.scoped(path);
      const overlap = (p: string, q: string) => { const a = process.platform === 'win32' ? p.toLowerCase() : p; const b = process.platform === 'win32' ? q.toLowerCase() : q; return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); };
      if (this.allTasks().some(x => x.state === 'in_progress' && t.scope.some(p => x.scope.some(q => overlap(p, q))))) throw new ArcaneError('WRITE_LEASE', 'Another worker owns an overlapping file scope.');
      const leaseToken = randomBytes(32).toString('hex'); t.state = 'in_progress'; t.worker = worker; t.leaseUntil = new Date(this.now() + 300000).toISOString(); t.progress = 'Claimed; scope leases are cooperative, not process isolation.'; this.save(t, hash(leaseToken)); return { task: t, leaseToken };
    });
  }
  private owned(taskId: string, token: unknown): WorkTask {
    this.expire(); const t = this.task(taskId); const r = this.db.prepare('SELECT lease_hash FROM tasks WHERE id=?').get(taskId) as Row;
    const expected = r.lease_hash as string | null; const actual = hash(textField(token, 'lease token', 128));
    if (t.state !== 'in_progress' || !expected || expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new ArcaneError('WRITE_LEASE', 'Worker lease is invalid or expired.');
    return t;
  }
  progress(input: unknown): WorkTask {
    const a = object(input); const t = this.owned(textField(a.taskId, 'task ID'), a.leaseToken); t.progress = textField(a.progress, 'progress', 4000); t.leaseUntil = new Date(this.now() + 300000).toISOString(); this.save(t); return t;
  }
  submit(input: unknown): WorkTask {
    const a = object(input); const t = this.owned(textField(a.taskId, 'task ID'), a.leaseToken);
    if (!Array.isArray(a.evidence) || a.evidence.length < 1 || a.evidence.length > 20) throw new ArcaneError('EVIDENCE', 'Submission requires 1..20 local evidence artifacts.');
    t.evidence = a.evidence.map(value => {
      const e = object(value);
      // Evidence may live outside the write scope (e.g. a centrally generated test report), but must be a direct in-project file.
      const full = realpathSync(resolve(this.project, this.scoped(e.path))); if (full !== this.project && !full.startsWith(this.project + sep)) throw new ArcaneError('EVIDENCE', 'Evidence escapes project.');
      const verified = this.verifyEvidence(e.path);
      return { path: verified.path, sha256: verified.sha256, bytes: verified.bytes, note: textField(e.note, 'evidence note', 2000), addedAt: this.iso() };
    });
    t.state = 'needs_review'; t.leaseUntil = null; t.progress = 'Evidence submitted; completion requires a reviewer decision.'; this.save(t, null); return t;
  }
  review(input: unknown): WorkTask {
    const a = object(input); const t = this.task(textField(a.taskId, 'task ID'));
    if (t.state !== 'needs_review' || typeof a.approved !== 'boolean') throw new ArcaneError('TASK_STATE', 'Only submitted tasks may be reviewed.');
    if (a.approved) for (const e of t.evidence) {
      // Bounded direct re-read: replaced, linked or oversized evidence can never be approved or allocate unboundedly.
      let current: { sha256: string; bytes: number } | null = null; try { current = this.verifyEvidence(e.path); } catch { current = null; }
      if (!current || current.sha256 !== e.sha256 || current.bytes !== e.bytes) throw new ArcaneError('EVIDENCE_CHANGED', 'Evidence changed after submission. Re-submit before approval.');
    }
    t.reviewNote = textField(a.note, 'review decision note', 4000); t.state = a.approved ? 'complete' : 'pending'; t.progress = a.approved ? 'Accepted by reviewer; acceptance is not inferred from the worker summary.' : 'Review requested changes.'; this.save(t); return t;
  }
  close(): void { this.db.close(); }
}
