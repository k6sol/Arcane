import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import { ArcaneError } from '../../protocol/src/providers.js';
import type { HumanDecision, WorkflowRecipe, WorkflowSubmission } from '../../core/src/workflow-recipes.js';
import type { TaskState } from './work-store.js';

export const WORKFLOW_STORE_LIMITS = Object.freeze({
  workflows: 64, commandsPerWorkflow: 256, recordBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024,
});
export type WorkflowCommandKind = 'create-recipe' | 'recipe-gate' | 'submit-evidence' | 'verify' | 'review-evidence' | 'reconcile';
export interface WorkflowAttempt {
  stepKey: string; number: number; subjectDigest: string;
  state: 'running' | 'busy' | 'submitted' | 'unsupported' | 'uncertain';
}
export interface WorkflowOperation {
  key: string; kind: WorkflowCommandKind; stepKey: string | null;
  submission: WorkflowSubmission | null; approved: boolean | null;
}
export interface StoredWorkflow {
  id: string; projectId: string; recipe: WorkflowRecipe; creationReceiptHash: string;
  runId: string | null; taskIds: Record<string, string>; taskStates: Record<string, TaskState>;
  state: 'creating' | 'active' | 'uncertain' | 'halted';
  submissions: WorkflowSubmission[]; decisions: HumanDecision[]; attempts: WorkflowAttempt[];
  operation: WorkflowOperation | null; revision: number;
}
export interface WorkflowCommand {
  key: string; workflowId: string; requestHash: string; kind: WorkflowCommandKind;
  receiptHash: string | null; state: 'running' | 'done' | 'uncertain';
  result: 'created' | 'decided' | 'submitted' | 'busy' | 'unsupported' | 'reviewed' | 'reconciled' | null;
}
type Row = Record<string, string | number | null>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(code: string, message: string): never { throw new ArcaneError(code, message); }

export function workflowProjectIdentity(projectPath: string): { projectPath: string; projectId: string } {
  const physical = realpathSync(projectPath);
  if (!lstatSync(physical).isDirectory()) fail('WORKFLOW_PROJECT', 'Expected a project directory.');
  return { projectPath: physical, projectId: hash(process.platform === 'win32' ? physical.toLowerCase() : physical) };
}
function noLinks(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) fail('WORKFLOW_STORAGE', 'Linked workflow storage is forbidden.');
  }
}
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** A single host writer, a project identity, bounded records and a write-ahead command journal.
 * This database cannot atomically commit with WorkStore. In-flight mutations become uncertain.
 * It is infrastructure for WorkflowService; routes must not expose these write methods.
 */
export class WorkflowStore {
  readonly projectId: string;
  readonly projectPath: string;
  private readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  private closed = false;

  constructor(options: { directory: string; projectPath: string }) {
    const identity = workflowProjectIdentity(options.projectPath);
    this.projectId = identity.projectId; this.projectPath = identity.projectPath;
    noLinks(options.directory);
    mkdirSync(options.directory, { recursive: true });
    const file = join(realpathSync(options.directory), 'workflow.sqlite');
    for (const name of ['workflow.sqlite', 'work.sqlite']) {
      for (const suffix of ['', '-wal', '-shm']) noLinks(join(realpathSync(options.directory), name) + suffix);
    }
    this.db = new DatabaseSync(file, { timeout: 2000, allowExtension: false });
    try {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (version > 1) fail('MIGRATION', 'Workflow database is newer than this build.');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS workflow_meta (id INTEGER PRIMARY KEY CHECK(id=1),project_id TEXT NOT NULL,project_path TEXT NOT NULL) STRICT;' +
        'CREATE TABLE IF NOT EXISTS workflow_owner (id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL) STRICT;' +
        'CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL) STRICT;' +
        'CREATE TABLE IF NOT EXISTS workflow_commands (key TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id),payload TEXT NOT NULL) STRICT;' +
        'PRAGMA user_version=1;',
      );
      this.transaction(() => {
        const meta = this.db.prepare('SELECT * FROM workflow_meta WHERE id=1').get() as Row | undefined;
        if (meta && meta.project_id !== this.projectId) fail('WORKFLOW_PROJECT', 'Workflow storage belongs to another project.');
        if (!meta) this.db.prepare('INSERT INTO workflow_meta VALUES(1,?,?)').run(this.projectId, this.projectPath);
        const owner = this.db.prepare('SELECT pid FROM workflow_owner WHERE id=1').get() as Row | undefined;
        if (owner && live(Number(owner.pid))) fail('WORKFLOW_OWNER', 'A workflow coordinator already owns this storage.');
        this.db.prepare('INSERT OR REPLACE INTO workflow_owner VALUES(1,?,?)').run(process.pid, this.owner);
        for (const row of this.db.prepare('SELECT payload FROM workflows').all() as Row[]) {
          const record = JSON.parse(String(row.payload)) as StoredWorkflow;
          if (!record.operation) continue;
          record.state = 'uncertain';
          for (const attempt of record.attempts) if (attempt.state === 'running') attempt.state = 'uncertain';
          record.revision++;
          this.db.prepare('UPDATE workflows SET revision=?,payload=? WHERE id=?').run(record.revision, JSON.stringify(record), record.id);
        }
        for (const row of this.db.prepare('SELECT payload FROM workflow_commands').all() as Row[]) {
          const command = JSON.parse(String(row.payload)) as WorkflowCommand;
          if (command.state === 'running') {
            command.state = 'uncertain';
            this.db.prepare('UPDATE workflow_commands SET payload=? WHERE key=?').run(JSON.stringify(command), command.key);
          }
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private open(): void {
    if (this.closed) fail('WORKFLOW_CLOSED', 'Workflow storage is closed.');
    const row = this.db.prepare('SELECT token FROM workflow_owner WHERE id=1').get() as Row | undefined;
    if (row?.token !== this.owner) fail('WORKFLOW_OWNER', 'Workflow storage ownership changed.');
  }
  get(id: string): StoredWorkflow {
    this.open();
    const row = this.db.prepare('SELECT payload FROM workflows WHERE id=?').get(id) as Row | undefined;
    if (!row) fail('WORKFLOW_RECORD', 'Unknown project workflow.');
    const record = JSON.parse(String(row.payload)) as StoredWorkflow;
    if (record.projectId !== this.projectId) fail('WORKFLOW_PROJECT', 'Workflow project identity changed.');
    return record;
  }
  list(): StoredWorkflow[] {
    this.open();
    return (this.db.prepare('SELECT id FROM workflows ORDER BY rowid DESC').all() as Row[]).map(row => this.get(String(row.id)));
  }
  command(key: string, requestHash: string): WorkflowCommand | undefined {
    this.open();
    const row = this.db.prepare('SELECT payload FROM workflow_commands WHERE key=?').get(key) as Row | undefined;
    if (!row) return undefined;
    const command = JSON.parse(String(row.payload)) as WorkflowCommand;
    if (command.requestHash !== requestHash) fail('WORKFLOW_IDEMPOTENCY', 'Idempotency key was used for a different command.');
    return command;
  }
  private write(record: StoredWorkflow, inserting: boolean): void {
    if (record.projectId !== this.projectId) fail('WORKFLOW_PROJECT', 'Workflow belongs to another project.');
    if (record.attempts.length > 48 || record.submissions.length > 24 || record.decisions.length > 72) fail('WORKFLOW_CAPACITY', 'Workflow collection bound exceeded.');
    const serialized = JSON.stringify({ ...record, revision: record.revision + 1 });
    const size = Buffer.byteLength(serialized);
    const total = Number((this.db.prepare('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS size FROM workflows WHERE id<>?').get(record.id) as Row).size);
    if (size > WORKFLOW_STORE_LIMITS.recordBytes || total + size > WORKFLOW_STORE_LIMITS.totalBytes) fail('WORKFLOW_CAPACITY', 'Workflow payload capacity exceeded.');
    if (inserting) {
      const count = Number((this.db.prepare('SELECT count(*) AS count FROM workflows').get() as Row).count);
      if (count >= WORKFLOW_STORE_LIMITS.workflows) fail('WORKFLOW_CAPACITY', 'Workflow capacity exceeded.');
      this.db.prepare('INSERT INTO workflows VALUES(?,?,?)').run(record.id, 1, serialized);
    } else {
      const result = this.db.prepare('UPDATE workflows SET revision=?,payload=? WHERE id=? AND revision=?').run(record.revision + 1, serialized, record.id, record.revision);
      if (Number(result.changes) !== 1) fail('WORKFLOW_CONFLICT', 'Workflow changed concurrently.');
    }
    record.revision++;
  }
  begin(record: StoredWorkflow, command: WorkflowCommand, inserting = false): void {
    this.open();
    this.transaction(() => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(command.key) || !/^[a-f0-9]{64}$/.test(command.requestHash) ||
        (command.receiptHash !== null && !/^[a-f0-9]{64}$/.test(command.receiptHash)) ||
        Buffer.byteLength(JSON.stringify(command)) > 1024) fail('WORKFLOW_INPUT', 'Invalid bounded journal command.');
      if (this.command(command.key, command.requestHash)) fail('WORKFLOW_IDEMPOTENCY', 'Command already exists.');
      if (command.receiptHash && this.db.prepare("SELECT key FROM workflow_commands WHERE json_extract(payload,'$.receiptHash')=? LIMIT 1").get(command.receiptHash)) {
        fail('WORKFLOW_IDEMPOTENCY', 'A human receipt may authorize only one durable command.');
      }
      const count = Number((this.db.prepare('SELECT count(*) AS count FROM workflow_commands WHERE workflow_id=?').get(record.id) as Row).count);
      if (count >= WORKFLOW_STORE_LIMITS.commandsPerWorkflow) fail('WORKFLOW_CAPACITY', 'Workflow command capacity exceeded.');
      if (command.workflowId !== record.id || command.state !== 'running' || record.operation?.key !== command.key) fail('WORKFLOW_INPUT', 'Invalid journal operation.');
      this.write(record, inserting);
      this.db.prepare('INSERT INTO workflow_commands VALUES(?,?,?)').run(command.key, record.id, JSON.stringify(command));
    });
  }
  finish(record: StoredWorkflow, command: WorkflowCommand): void {
    this.open();
    this.transaction(() => {
      const current = this.command(command.key, command.requestHash);
      if (!current || current.state !== 'running' || current.workflowId !== record.id) fail('WORKFLOW_CONFLICT', 'Journal operation changed.');
      this.write(record, false);
      this.db.prepare('UPDATE workflow_commands SET payload=? WHERE key=?').run(JSON.stringify(command), command.key);
    });
  }
  interrupt(id: string, key: string): void {
    this.open();
    this.transaction(() => {
      const record = this.get(id);
      if (record.operation?.key !== key) fail('WORKFLOW_CONFLICT', 'Journal operation changed.');
      record.state = 'uncertain';
      for (const attempt of record.attempts) if (attempt.state === 'running') attempt.state = 'uncertain';
      this.write(record, false);
      const row = this.db.prepare('SELECT payload FROM workflow_commands WHERE key=?').get(key) as Row;
      const command = JSON.parse(String(row.payload)) as WorkflowCommand;
      command.state = 'uncertain';
      this.db.prepare('UPDATE workflow_commands SET payload=? WHERE key=?').run(JSON.stringify(command), key);
    });
  }
  close(): void {
    if (this.closed) return;
    this.db.prepare('DELETE FROM workflow_owner WHERE token=?').run(this.owner);
    this.closed = true; this.db.close();
  }
}

