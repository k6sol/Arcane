import { DatabaseSync } from 'node:sqlite';
import { sqliteTransportPath } from './sqlite-path.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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

/** Cooperative workflow leases, NOT an OS sandbox for agents/native tools. */
export class WorkStore {
  private db: DatabaseSync;
  private project: string;
  private now: () => number;
  constructor(options: { directory: string; projectPath: string; now?: () => number }) {
    mkdirSync(options.directory, { recursive: true }); this.project = realpathSync(options.projectPath); this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(sqliteTransportPath(join(options.directory, 'work.sqlite')), { timeout: 2000, allowExtension: false });
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > 1) { this.db.close(); throw new ArcaneError('MIGRATION', 'Work database is newer than this build.'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL,lease_hash TEXT) STRICT;
      PRAGMA user_version=1;`);
    // Native worker handles do not survive a daemon restart. Preserve work/evidence for review.
    for (const task of this.allTasks()) if (task.state === 'in_progress') { task.state = 'interrupted'; task.leaseUntil = null; task.progress = 'Daemon restarted. Inspect artifacts before reclaiming.'; this.save(task, null); }
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
    const run: WorkRun = { id: runId, title, objective, createdAt: now, tasks };
    this.transaction(() => { this.db.prepare('INSERT INTO runs(id,payload) VALUES(?,?)').run(runId, JSON.stringify({ id: runId, title, objective, createdAt: now })); const stmt = this.db.prepare('INSERT INTO tasks(id,run_id,payload) VALUES(?,?,?)'); for (const task of tasks) stmt.run(task.id, runId, JSON.stringify(task)); });
    return run;
  }
  task(id: string): WorkTask { const r = this.db.prepare('SELECT payload FROM tasks WHERE id=?').get(id) as Row | undefined; if (!r) throw new ArcaneError('TASK', 'Unknown task.'); return JSON.parse(r.payload as string) as WorkTask; }
  private allTasks(): WorkTask[] { return (this.db.prepare('SELECT payload FROM tasks ORDER BY rowid').all() as Row[]).map(r => JSON.parse(r.payload as string) as WorkTask); }
  runs(): WorkRun[] {
    this.expire(); const tasks = this.allTasks();
    return (this.db.prepare('SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100').all() as Row[]).map(r => { const run = JSON.parse(r.payload as string) as WorkRun; return { ...run, tasks: tasks.filter(t => t.runId === run.id) }; });
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
      const e = object(value); const path = this.scoped(e.path);
      // Evidence may live outside the write scope (e.g. a centrally generated test report), but must be in project.
      const full = realpathSync(resolve(this.project, path)); if (full !== this.project && !full.startsWith(this.project + sep)) throw new ArcaneError('EVIDENCE', 'Evidence escapes project.');
      const stat = statSync(full); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new ArcaneError('EVIDENCE', 'Evidence must be a file <=16 MiB.');
      const bytes = readFileSync(full); return { path: relative(this.project, full).split(sep).join('/'), sha256: hash(bytes), bytes: bytes.length, note: textField(e.note, 'evidence note', 2000), addedAt: this.iso() };
    });
    t.state = 'needs_review'; t.leaseUntil = null; t.progress = 'Evidence submitted; completion requires a reviewer decision.'; this.save(t, null); return t;
  }
  review(input: unknown): WorkTask {
    const a = object(input); const t = this.task(textField(a.taskId, 'task ID'));
    if (t.state !== 'needs_review' || typeof a.approved !== 'boolean') throw new ArcaneError('TASK_STATE', 'Only submitted tasks may be reviewed.');
    if (a.approved) for (const e of t.evidence) { const full = realpathSync(resolve(this.project, this.scoped(e.path))); if (hash(readFileSync(full)) !== e.sha256) throw new ArcaneError('EVIDENCE_CHANGED', 'Evidence changed after submission. Re-submit before approval.'); }
    t.reviewNote = textField(a.note, 'review decision note', 4000); t.state = a.approved ? 'complete' : 'pending'; t.progress = a.approved ? 'Accepted by reviewer; acceptance is not inferred from the worker summary.' : 'Review requested changes.'; this.save(t); return t;
  }
  close(): void { this.db.close(); }
}
